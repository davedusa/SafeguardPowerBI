## Development guide

### Set up the development environment

To develop a Power BI custom connector, the following code editors can be used:

- Visual Studio
- Visual Studio Code

Both require a dedicated [Power Query SDK] extension to be able to create and build data connector projects. However, Microsoft suggests using Visual Studio Code, as the Visual Studio Code Power Query SDK will eventually become the default and maintained SDK.

To set up a Visual Studio Code development environment:

- Install [Visual Studio Code]
- Install [Visual Studio Code Power Query SDK] (This will also install the Power Query / M Language extension.)

To make development easier, you can use `make` commands for building the custom connector and running the tests. In order to install `make` on Windows:

- Install [Chocolatey]
- Install `make` via Chocolatey by running the following command: `choco install make`

### Build the connector from source code

1. Obtain the source code from the GitHub repository
2. Install [MSBuild] for Windows
3. Make sure that MSBuild is included in your `PATH` variable.
4. Build the source code with one of the following options:
    - In Visual Studio Code: Go to **Terminal > Run Build Task...**, and select **Build connenctor project using MSBuild**
    - From the command line: use the `make build` command

### Testing

The test framework has been decoupled from the connector code, so running tests is only available from the command line. You can find the tests and the unit test framework under the `Test` subfolder. This is a separate Power Query SDK project, so it requires building separately. The `make build` command also builds the test project.

You can run the tests with `PQTest.exe`, which comes with the Power Query SDK. By default, it is located in the SDK's extension folder, for example:

```
%USERPROFILE%\.vscode\extensions\powerquery.vscode-powerquery-sdk-0.2.2-win32-x64\.nuget\Microsoft.PowerQuery.SdkTools.2.114.4\tools\
```

To run tests using **make** targets, you must include the path of the `PQTest.exe` in your `PATH` variable. You have the following options:

- Run all tests using `make unit-tests`
- Run an individual test using `make unit-test test_file=<Path-To-The-Query-Pq-File>`

### Safeguard Sessions release automation

The GitHub issue form prepares a Safeguard Sessions release; merging its generated PR creates a **draft** release only. The automation never publishes a public release.

The post-merge workflow uses `pull_request_target` for closed PRs so selected target branches that predate the workflow still trigger it. It checks out and executes only trusted default-branch automation in the credentialed publish job; it does not execute PR source code there. The rebuild job uses read-only permissions, and both jobs verify and use the exact `merge_commit_sha` from the event before release publication.

Repository administrators must enable GitHub Actions, set workflow-token permissions to **Read and write permissions**, and allow Actions to create pull requests in **Settings > Actions > General**. The workflow requests read access for validation/build jobs and narrowly scoped `contents: write` / `pull-requests: write` access only for PR publication; draft publication receives `contents: write`. Do not add credentials to issue fields or workflow inputs.

To rehearse the flow in a fork or test repository:

1. Make sure the automation workflows and issue form are on that repository's default branch. GitHub only loads issue forms and issue-triggered workflows from the default branch.
2. Select existing source and target branches. They may both remain `main`, as prefilled, or be different test branches; choose a target whose current commit is an ancestor of the eventual merge commit.
3. Open a new **Safeguard Sessions release request** issue as an account with current `write`, `maintain`, or `admin` repository permission. Keep the required marker unchanged, use a unique unused connector/SPS version pair, and review the exact supported-version list and changelog body. The event snapshot is immutable to that workflow run; editing the issue does not amend an in-progress request.
4. Follow the preparation run. It records source/target commit SHAs and release inputs in an immutable run artifact. The build/test job has no write token, uses the trusted default-branch scripts, and can only publish a branch after bootstrap, both builds, and both test suites succeed.
5. Review the generated PR against the selected target branch. A human merge triggers a fresh build and tests at the exact merged commit; checksums are recalculated and all four non-empty assets are verified before the tag and draft release are created.
6. To resume a failed post-merge upload, use **Actions > Draft Safeguard Sessions release > Re-run failed jobs**. The workflow re-authenticates the originating preparation run and immutable metadata, rebuilds from the merged SHA, reuses only a matching tag/draft, and uploads any missing or mismatched assets. Investigate any conflicting tag or public release rather than deleting or overwriting it.

Use a new issue for corrected inputs after a preflight or build failure. If PR publication failed after the release branch was pushed, rerun the failed publication job; it reuses only the exact prepared commit and matching open PR. The automation never force-pushes or replaces a conflicting branch. A closed PR that was not merged is ignored. Because GitHub concurrency keeps only one pending run per group, rerun any preparation/publication run that GitHub marks canceled while waiting.

Preparation commits must change the connector and changelog and may only change the four approved release paths: the connector, supported versions module, changelog, and release request form. The supported versions module and form may remain unchanged when their contents already match the request (for example, an SPS patch release). All four final file contents are still verified; trusted build-script overlays are not included in the release commit.

PRs opened with the repository's `GITHUB_TOKEN` generally do **not** trigger other `pull_request` workflows, so required checks that depend on those events may remain pending. If required PR checks are configured, an administrator may approve a GitHub App installation token with only the needed contents/PR permissions, then store it as `RELEASE_AUTOMATION_TOKEN`; the preparation publication job uses it when present and otherwise falls back to `GITHUB_TOKEN`. Do not configure this token in a public fork without an explicit security review. This implementation changes no branch protections; the public test fork has no protections configured.

### Coding style

To adhere with our coding style, consider the following when **writing code**:

- Folders should be named using **PascalCase**
- Functions should be named using **PascalCase**
- Variables should be named using **camelCase**

When writing **commit messages**, consider the following:

- The commit message header should be a maximum of 50 characters long
- Start the commit message header by defining which Safeguard product the modification addresses
- Insert an empty line between the commit message header and body
- Define the scope of the modification
    - It should highlight the relative path to the file/folder in the repository that contains the most essential modification of the commit
- Do not forget to describe the "why-s" in the commit message body
- If the modification corresponds to an issue in the issue tracking system, include its ID at the end of the commit message
    - If it only has a work item in Azure DevOps: `References: azure #<issue-id>`
    - If it only has a GitHub issue: `References: #<issue-id>`
    - If it both has a work item in Azure DevOps and a GitHub issue: `References: azure #<azure-id>, #<github-id>`
- For examples, view the [Commit history of the main branch]

## Error codes

When introducing a new error code, please consider the following:

- The error codes from the HTTP Requests should have a zero at the end if there is already an error ending with a zero then the next error code falling in the same HTTP Request category should be incremented by one.
- The error code for errors originating from the connector should be incremented by one.
- List the new error in the [Troubleshooting] guide.

## How to contribute to the project

1. Fork the [GitHub project]
2. Create a branch in Git
3. Commit your changes
4. Push to the branch you have just created
5. Open a [Pull Request]

Make sure you respect the [Coding style](#coding-style) and know the essentials of [Creating good commits].

**For One Identity Developers:**

- When accepting a contribution or commiting a change consider whether the change requires updating the CHANGELOG.md.
- Consider whether the change requires updating the One Idenity Safeguard Power BI Connector Tutorial documentation.

## Useful documents

- [Power Query SDK]
- [Visual Studio Code Power Query SDK GitHub]
- [Power Query M formula lanaguage]
- [In-depth tutorial on Power Query M]
- [Creating good commits]

<!-- Links -->

[GitHub project]: https://github.com/OneIdentity/SafeguardPowerBI
[Commit history of the main branch]: https://github.com/OneIdentity/SafeguardPowerBI/commits/main
[Pull Request]: https://github.com/OneIdentity/SafeguardPowerBI/pulls

[Power Query SDK]: https://learn.microsoft.com/en-us/power-query/installingsdk
[Visual Studio Code Power Query SDK GitHub]: https://github.com/microsoft/vscode-powerquery-sdk/
[Power Query M formula lanaguage]: https://learn.microsoft.com/en-us/powerquery-m/
[In-depth tutorial on Power Query M]: https://bengribaudo.com/blog/2017/11/17/4107

[Visual Studio Code]: https://code.visualstudio.com/
[Visual Studio Code Power Query SDK]: https://marketplace.visualstudio.com/items?itemName=PowerQuery.vscode-powerquery-sdk

[Chocolatey]: https://chocolatey.org/install
[MSBuild]: https://github.com/microsoft/vscode-powerquery-sdk/issues/192#issuecomment-1311882460

[Creating good commits]: https://google.github.io/eng-practices/review/developer/

[Troubleshooting]: TROUBLESHOOTING.md

<!-- Links END -->
