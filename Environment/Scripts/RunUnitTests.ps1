param(
    [Parameter(Mandatory = $true)]
    [string]$Project,
    [string]$TestFile
)

$ErrorActionPreference = "Stop"

$scriptpath = $MyInvocation.MyCommand.Path
$dir = Split-Path $scriptpath

. $dir\PreCheck.ps1 -Project $Project

function LogError {
    param (
        $testResult
    )
    Write-Host "$($testResult.Name): " -NoNewline
    Write-Host "Error" -ForegroundColor red
    Write-Host "Message: " -NoNewline -ForegroundColor red
    Write-Host $testResult.Error.Message
    Write-Host "Details: " -NoNewline -ForegroundColor red
    Write-Host $testResult.Error.Details

}

function LogSuccess {
    param (
        $testResult
    )
    Write-Host "$($testResult.Name): " -NoNewline
    Write-Host  "Success" -ForegroundColor green
}

function LogFail {
    param (
        $testResult
    )
    Write-Host "$($testResult.Name): " -NoNewline
    Write-Host "Fail" -ForegroundColor red
    for (($i = 1); $i -lt $testResult.Output.Details.Length; $i++) {
        $cleanedTestResult = $testResult.Output[$i].Details.Trim()
        # remove opening and closing parenthesis and split string to expected and actual output
        $resultArray = $cleanedTestResult.Substring(1, $cleanedTestResult.Length - 2) -split "<>"
        $expectedResult = $resultArray[0].Trim()
        $actualResult = $resultArray[1].Trim()
        Write-Host  "Assert Failed: " -NoNewline -ForegroundColor red
        Write-Host $testResult.Output[$i].Notes 
        Write-Host  "Expected Output: " -NoNewline -ForegroundColor green
        Write-Host $expectedResult
        Write-Host  "Actual Output: " -NoNewline -ForegroundColor red
        Write-Host $actualResult
    }
    
}

$output = "short"
$testInput = if ($TestFile -eq "") { $config.UnitTestsPath } else { $TestFile }

Write-Host "Running unit tests in $testInput"

$pqtestOutput = pqtest run-test `
    --extension $config.ConnectorMezPath `
    --extension $config.TestMezPath `
    --environmentConfiguration output=$output `
    --queryFile $testInput `
    --prettyPrint 

$pqtestExitCode = $LASTEXITCODE
if ($pqtestExitCode -ne 0) {
    throw "pqtest failed with exit code $pqtestExitCode."
}

$pqtestOutputText = @($pqtestOutput) -join [Environment]::NewLine
if ([string]::IsNullOrWhiteSpace($pqtestOutputText)) {
    throw "pqtest returned no test results."
}

if ($pqtestOutputText.TrimStart()[0] -ne "[") {
    throw "pqtest returned results in an invalid format. Expected a JSON array."
}

try {
    $resultsAsObject = @(ConvertFrom-Json -InputObject $pqtestOutputText -ErrorAction Stop)
}
catch {
    throw "pqtest returned malformed JSON: $($_.Exception.Message)"
}

if ($resultsAsObject.Count -eq 0) {
    throw "pqtest returned an empty test-results array."
}

$isEveryTestSuccessful = $true
foreach ($result in $resultsAsObject) {
    if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Name) -or $null -eq $result.Output) {
        throw "pqtest returned a result with an invalid structure."
    }

    $resultStatus = $result.Output.PSObject.Properties["Result"]
    if ($null -eq $resultStatus) {
        throw "pqtest returned a result without a status field."
    }

    if ($null -eq $resultStatus.Value) {
        if ($null -eq $result.Error) {
            throw "pqtest returned a result without a status or error details."
        }

        $isEveryTestSuccessful = $false
        LogError($result)
    }
    elseif ($resultStatus.Value -eq "Success") {
        LogSuccess($result)
    }
    elseif ($resultStatus.Value -eq "Fail") {
        $isEveryTestSuccessful = $false
        LogFail($result)
    }
    else {
        throw "pqtest returned an unsupported result status '$($resultStatus.Value)'."
    }
}

if (!$isEveryTestSuccessful) {
    exit 1
}
 