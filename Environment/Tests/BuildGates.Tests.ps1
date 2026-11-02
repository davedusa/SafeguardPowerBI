$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$scriptsDir = Join-Path $repoRoot "Environment\Scripts"
$testRoot = Join-Path $repoRoot "Environment\Tests\.build-gates-$([Guid]::NewGuid().ToString('N'))"
$windowsPowerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"

function Assert {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Write-TextFile {
    param(
        [string]$Path,
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

function New-Fixture {
    param(
        [string]$Name
    )

    $root = Join-Path $testRoot $Name
    $scripts = Join-Path $root "Environment\Scripts"
    $venv = Join-Path $root ".venv"
    $bin = Join-Path $venv "bin"
    $dotnet = Join-Path $venv "dotnet"

    [void](New-Item -ItemType Directory -Path $scripts -Force)
    [void](New-Item -ItemType Directory -Path $bin -Force)
    [void](New-Item -ItemType Directory -Path $dotnet -Force)
    foreach ($scriptName in @("Build.ps1", "RunUnitTests.ps1", "Bootstrap.ps1", "PreCheck.ps1", "LoadConfig.ps1", "Cleanup.ps1")) {
        Copy-Item (Join-Path $scriptsDir $scriptName) (Join-Path $scripts $scriptName)
    }

    $config = @{
        VenvPath = $venv
        AliasesPath = Join-Path $venv "aliases"
        ConnectorProjPath = "connector.csproj"
        TestProjPath = "tests.csproj"
        UnitTestsPath = "unit-tests.pq"
        ConnectorMezPath = "connector.mez"
        TestMezPath = "tests.mez"
        ReportTemplatePaths = @{}
    }
    ConvertTo-Json $config | Set-Content (Join-Path $venv "SafeguardCommon.config.json") -Encoding ASCII
    ConvertTo-Json $config | Set-Content (Join-Path $venv "SafeguardTest.config.json") -Encoding ASCII

    $dotnetStub = @'
@echo off
echo %*>>"%DOTNET_CALLS%"
if "%DOTNET_FAIL_PROJECT%"=="%~2" exit /b 17
exit /b 0
'@
    Write-TextFile (Join-Path $bin "dotnet.cmd") $dotnetStub
    $pqtestStub = @'
@echo off
if not "%PQTEST_OUTPUT%"=="" type "%PQTEST_OUTPUT%"
exit /b %PQTEST_EXITCODE%
'@
    Write-TextFile (Join-Path $bin "pqtest.cmd") $pqtestStub
    Set-Alias -Name dotnet -Value (Join-Path $bin "dotnet.cmd") -Scope Global
    Set-Alias -Name pqtest -Value (Join-Path $bin "pqtest.cmd") -Scope Global
    Export-Alias -Name dotnet,pqtest -Path (Join-Path $venv "aliases") -Force

    $runner = @'
param([string]$Mode, [string]$Project)
$ErrorActionPreference = "Stop"
try {
switch ($Mode) {
    "build" { & "$PSScriptRoot\Environment\Scripts\Build.ps1" -Project $Project }
    "tests" { & "$PSScriptRoot\Environment\Scripts\RunUnitTests.ps1" -Project $Project }
}
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
'@
    Write-TextFile (Join-Path $root "RunFixture.ps1") $runner

    return @{
        Root = $root
        Venv = $venv
        Bin = $bin
        Dotnet = $dotnet
    }
}

function Invoke-Fixture {
    param(
        [hashtable]$Fixture,
        [string]$Mode,
        [string]$Project = "SafeguardCommon"
    )

    $stdoutPath = Join-Path $Fixture.Root "stdout.txt"
    $stderrPath = Join-Path $Fixture.Root "stderr.txt"
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode "{1}" -Project "{2}"' -f `
        (Join-Path $Fixture.Root "RunFixture.ps1"), $Mode, $Project
    $process = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WorkingDirectory $Fixture.Root `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    return @{
        ExitCode = $process.ExitCode
        Output = "$(Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue)`n$(Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue)"
    }
}

function Invoke-BootstrapFixture {
    param([hashtable]$Fixture)

    $stdoutPath = Join-Path $Fixture.Root "bootstrap-stdout.txt"
    $stderrPath = Join-Path $Fixture.Root "bootstrap-stderr.txt"
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f `
        (Join-Path $Fixture.Root "Environment\Scripts\Bootstrap.ps1")
    $process = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WorkingDirectory $Fixture.Root `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    return @{
        ExitCode = $process.ExitCode
        Output = "$(Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue)`n$(Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue)"
    }
}

function Initialize-BootstrapFixture {
    param(
        [hashtable]$Fixture,
        [string]$InstallerContent
    )

    [void](New-Item -ItemType Directory -Path (Join-Path $Fixture.Root "Environment\Config") -Force)
    Copy-Item (Join-Path $repoRoot "Environment\Config\packageVersions.json") (Join-Path $Fixture.Root "Environment\Config\packageVersions.json")
    Copy-Item (Join-Path $repoRoot "Environment\Config\nuget.config") (Join-Path $Fixture.Root "Environment\Config\nuget.config")
    [void](New-Item -ItemType Directory -Path (Join-Path $Fixture.Root "SafeguardTest") -Force)
    Write-TextFile (Join-Path $Fixture.Root "SafeguardTest\config.json") '{"ConnectorProjPath":"a","TestProjPath":"b","UnitTestsPath":"c","ConnectorMezPath":"d","TestMezPath":"e","ReportTemplatePaths":{}}'
    Write-TextFile (Join-Path $Fixture.Dotnet "dotnet-install.ps1") $InstallerContent
    Write-TextFile (Join-Path $Fixture.Dotnet "dotnet.exe") ""
}

function Test-BuildStopsAfterEachNativeFailure {
    $fixture = New-Fixture "build-success"
    $env:DOTNET_CALLS = Join-Path $fixture.Root "dotnet-calls.txt"
    $env:DOTNET_FAIL_PROJECT = ""
    $result = Invoke-Fixture $fixture "build"
    $calls = @(Get-Content $env:DOTNET_CALLS -ErrorAction SilentlyContinue)
    Assert ($result.ExitCode -eq 0) "Build.ps1 failed when both dotnet commands succeeded. $($result.Output)"
    Assert ($calls.Count -eq 2) "Build.ps1 did not invoke both dotnet commands on success."

    foreach ($failedProject in @("connector.csproj", "tests.csproj")) {
        $fixture = New-Fixture "build-$($failedProject.Replace('.', '-'))"
        $env:DOTNET_CALLS = Join-Path $fixture.Root "dotnet-calls.txt"
        $env:DOTNET_FAIL_PROJECT = $failedProject

        $result = Invoke-Fixture $fixture "build"
        $calls = @(Get-Content $env:DOTNET_CALLS -ErrorAction SilentlyContinue)
        Assert ($result.ExitCode -ne 0) "Build.ps1 succeeded when dotnet failed for $failedProject."
        Assert ($calls.Count -eq $(if ($failedProject -eq "connector.csproj") { 1 } else { 2 })) "Build.ps1 did not stop at the failing dotnet command for $failedProject."
    }

    Remove-Item Env:\DOTNET_CALLS,Env:\DOTNET_FAIL_PROJECT -ErrorAction SilentlyContinue
}

function Test-UnitTestResultsAndNativeFailures {
    $cases = @(
        @{ Name = "native-failure"; Json = '[{"Name":"sample","Output":{"Result":"Success"}}]'; ExitCode = 23; ExpectedSuccess = $false },
        @{ Name = "empty-output"; Json = ""; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "empty-results"; Json = '[]'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "malformed-json"; Json = '{"Name":'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "invalid-shape"; Json = '{"Name":"sample","Output":{"Result":"Success"}}'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "missing-output"; Json = '[{"Name":"sample"}]'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "missing-status"; Json = '[{"Name":"sample","Output":{},"Error":{"Message":"error"}}]'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "test-error"; Json = '[{"Name":"sample","Output":{"Result":null},"Error":{"Message":"error","Details":"failed"}}]'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "test-failure"; Json = '[{"Name":"sample","Output":{"Result":"Fail","Details":[]}}]'; ExitCode = 0; ExpectedSuccess = $false },
        @{ Name = "success"; Json = '[{"Name":"sample","Output":{"Result":"Success"}}]'; ExitCode = 0; ExpectedSuccess = $true }
    )

    foreach ($case in $cases) {
        $fixture = New-Fixture "tests-$($case.Name)"
        $env:PQTEST_OUTPUT = Join-Path $fixture.Root "pqtest-output.json"
        $env:PQTEST_EXITCODE = [string]$case.ExitCode
        Write-TextFile $env:PQTEST_OUTPUT $case.Json

        $result = Invoke-Fixture $fixture "tests"
        $succeeded = $result.ExitCode -eq 0
        Assert ($succeeded -eq $case.ExpectedSuccess) "RunUnitTests.ps1 returned exit $($result.ExitCode) for case '$($case.Name)'. Output: $($result.Output)"
    }

    Remove-Item Env:\PQTEST_OUTPUT,Env:\PQTEST_EXITCODE -ErrorAction SilentlyContinue
}

function Test-BootstrapRejectsFailedInstallerAndNuget {
    $fixture = New-Fixture "bootstrap-installer"
    Initialize-BootstrapFixture $fixture '& $env:ComSpec /c exit 37'
    Copy-Item (Join-Path $env:WINDIR "System32\where.exe") (Join-Path $fixture.Bin "nuget.exe")
    Copy-Item (Join-Path $env:WINDIR "System32\where.exe") (Join-Path $fixture.Root "install.exe")
    $marker = Join-Path $fixture.Venv "BOOTSRAP_FINISHED_FLAG"
    Write-TextFile $marker "stale"

    $result = Invoke-BootstrapFixture $fixture
    Assert ($result.ExitCode -ne 0) "Bootstrap.ps1 succeeded when the .NET installer native command failed. $($result.Output)"
    Assert (-not (Test-Path $marker)) "Bootstrap.ps1 left a stale success marker after an installer failure."

    $fixture = New-Fixture "bootstrap-nuget"
    Initialize-BootstrapFixture $fixture "Write-Output 'installer ran'"
    Copy-Item (Join-Path $env:WINDIR "System32\where.exe") (Join-Path $fixture.Bin "nuget.exe")
    $result = Invoke-BootstrapFixture $fixture
    Assert ($result.ExitCode -ne 0) "Bootstrap.ps1 succeeded when NuGet returned a non-zero native exit code. $($result.Output)"
    Assert (-not (Test-Path (Join-Path $fixture.Venv "BOOTSRAP_FINISHED_FLAG"))) "Bootstrap.ps1 wrote a success marker after NuGet failed."
}

try {
    [void](New-Item -ItemType Directory -Path $testRoot -Force)
    Test-BuildStopsAfterEachNativeFailure
    Test-UnitTestResultsAndNativeFailures
    Test-BootstrapRejectsFailedInstallerAndNuget
    Write-Output "Build-gate tests passed."
}
finally {
    Remove-Item Env:\DOTNET_CALLS,Env:\DOTNET_FAIL_PROJECT,Env:\PQTEST_OUTPUT,Env:\PQTEST_EXITCODE -ErrorAction SilentlyContinue
    Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
