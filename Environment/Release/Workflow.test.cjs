'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  AuthorizeIssueAuthor,
  CreatePreparationPlan,
  ValidateBranchName,
  ValidatePreparationMetadata,
  ValidatePreparedArtifact,
  PublishDraftRelease,
  VerifyCommitFiles,
} = require('./Workflow.cjs');
const { VerifyReleaseFiles } = require('./Request.cjs');

function PreparationFixture(t) {
  const trusted = path.resolve(__dirname, '..', '..');
  const workspace = fs.mkdtempSync(path.join(__dirname, 'WorkflowFixture-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(workspace, 'source');
  function Git(...args) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', trusted, root], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(clone.status, 0, clone.stderr);
  Git('config', 'core.autocrlf', 'false');
  Git('config', 'user.name', 'Release test');
  Git('config', 'user.email', 'release-test@example.invalid');
  Git('config', 'commit.gpgsign', 'false');
  Git('checkout', '--detach', 'd685181caf38afe4b2b51e44e05266ff0b4e4ae0');
  const sha = Git('rev-parse', 'HEAD');
  const releaseRequest = {
    connectorVersion: '2.0.9001102',
    spsVersion: '9.1.1',
    supportedVersions: ['7.3', '7.4', '7.5', '8.0', '8.1', '8.2', '9.0', '9.1'],
    sourceBranch: 'fixture/source',
    targetBranch: 'fixture/target',
    changelogBody: '### Compatible SPS Versions\n\n* Feature: 7.3.0 - 9.1.1',
  };
  const plan = {
    schemaVersion: 1,
    repository: 'fixture/SafeguardPowerBI',
    workflowPath: '.github/workflows/prepare-release.yml',
    automationSha: Git('rev-parse', 'origin/HEAD'),
    runId: 41481114369,
    runAttempt: 1,
    issueNumber: 123,
    issueAuthor: 'release-author',
    request: releaseRequest,
    source: { branch: releaseRequest.sourceBranch, sha },
    target: { branch: releaseRequest.targetBranch, sha },
    release: { tag: 'v2.0.9001102+sps9.1.1', commitSha: null },
  };
  function Cli(command) {
    return spawnSync(process.execPath, [path.join(__dirname, 'Workflow.cjs'), command], {
      cwd: trusted,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        SOURCE_DIRECTORY: root,
        TRUSTED_DIRECTORY: trusted,
        RELEASE_PLAN: Buffer.from(JSON.stringify(plan)).toString('base64'),
        GITHUB_RUN_ID: String(plan.runId),
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: path.join(workspace, 'outputs'),
        GITHUB_STEP_SUMMARY: path.join(workspace, 'summary'),
      },
    });
  }
  const supportedVersions = fs.readFileSync(
    path.join(root, 'SafeguardSessions', 'Src', 'Modules', 'Version', 'SupportedVersions.pqm'),
    'utf8',
  );
  const prepared = Cli('prepare-files');
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  return { root, workspace, plan, supportedVersions, Git, Cli };
}

test('preparation CLI accepts an SPS patch with unchanged supported versions', (t) => {
  const fixture = PreparationFixture(t);
  const { root, workspace, plan, Git, Cli } = fixture;
  const supportedPath = 'SafeguardSessions/Src/Modules/Version/SupportedVersions.pqm';
  assert.equal(
    fs.readFileSync(path.join(root, supportedPath), 'utf8'),
    fixture.supportedVersions,
  );
  assert.equal(Git('diff', '--name-only', '--', supportedPath), '');
  const finalized = Cli('finalize-preparation');
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const metadata = JSON.parse(fs.readFileSync(path.join(workspace, 'release-metadata.json'), 'utf8'));
  assert.equal(Git('rev-parse', 'HEAD^'), plan.source.sha);
  assert.deepEqual(Git('diff', '--name-only', `${plan.source.sha}..HEAD`).split('\n').sort(), [
    '.github/ISSUE_TEMPLATE/release-request.yml',
    'SafeguardSessions/CHANGELOG.md',
    'SafeguardSessions/Src/SafeguardSessions.pq',
  ]);
  const verified = VerifyCommitFiles(root, metadata);
  assert.equal(VerifyReleaseFiles(verified.files, plan.request).valid, true);
  assert.equal(verified.notes, plan.request.changelogBody);
  Git('bundle', 'verify', path.join(workspace, 'release.bundle'));
});

test('preparation CLI accepts an already matching form without changing it', (t) => {
  const { root, workspace, plan, Git, Cli } = PreparationFixture(t);
  Git('add', '--', '.github/ISSUE_TEMPLATE/release-request.yml');
  Git('commit', '-m', 'Fixture matching form');
  plan.source.sha = Git('rev-parse', 'HEAD');
  plan.target.sha = plan.source.sha;
  const finalized = Cli('finalize-preparation');
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  assert.deepEqual(Git('diff', '--name-only', `${plan.source.sha}..HEAD`).split('\n').sort(), [
    'SafeguardSessions/CHANGELOG.md',
    'SafeguardSessions/Src/SafeguardSessions.pq',
  ]);
  const metadata = JSON.parse(fs.readFileSync(path.join(workspace, 'release-metadata.json'), 'utf8'));
  assert.equal(VerifyCommitFiles(root, metadata).notes, plan.request.changelogBody);
});

test('preparation CLI rejects unrelated staged files without committing', (t) => {
  const { root, workspace, plan, Git, Cli } = PreparationFixture(t);
  fs.appendFileSync(path.join(root, 'README.md'), '\nUnrelated staged change.\n');
  Git('add', '--', 'README.md');
  const finalized = Cli('finalize-preparation');
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /outside the four approved release/);
  assert.equal(Git('rev-parse', 'HEAD'), plan.source.sha);
  assert.equal(fs.existsSync(path.join(workspace, 'release-metadata.json')), false);
});

test('preparation CLI rejects an unrelated source commit', (t) => {
  const { root, workspace, Git, Cli } = PreparationFixture(t);
  fs.appendFileSync(path.join(root, 'README.md'), '\nUnrelated commit.\n');
  Git('add', '--', 'README.md');
  Git('commit', '-m', 'Unrelated fixture commit');
  const sourceHead = Git('rev-parse', 'HEAD');
  const finalized = Cli('finalize-preparation');
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /Source checkout does not match the selected source commit/);
  assert.equal(Git('rev-parse', 'HEAD'), sourceHead);
  assert.equal(fs.existsSync(path.join(workspace, 'release-metadata.json')), false);
});

test('preparation CLI requires a connector change', (t) => {
  const { workspace, plan, Git, Cli } = PreparationFixture(t);
  Git('restore', '--', 'SafeguardSessions/Src/SafeguardSessions.pq');
  const finalized = Cli('finalize-preparation');
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /must change the connector and changelog/);
  assert.equal(Git('rev-parse', 'HEAD'), plan.source.sha);
  assert.equal(fs.existsSync(path.join(workspace, 'release-metadata.json')), false);
});

test('prepared commit verification rejects unrelated paths and invalid final contents', (t) => {
  const { root, workspace, Git, Cli } = PreparationFixture(t);
  const finalized = Cli('finalize-preparation');
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const metadata = JSON.parse(fs.readFileSync(path.join(workspace, 'release-metadata.json'), 'utf8'));
  const releaseSha = metadata.release.commitSha;
  for (const [file, text, expected] of [
    ['README.md', 'Unrelated committed change.\n', /outside the four approved release/],
    ['SafeguardSessions/Src/Modules/Version/SupportedVersions.pqm', 'invalid\n', /Prepared release files are invalid/],
    ['.github/ISSUE_TEMPLATE/release-request.yml', 'invalid\n', /Release issue form/],
    ['SafeguardSessions/Src/SafeguardSessions.pq', null, /must change the connector and changelog/],
    ['SafeguardSessions/CHANGELOG.md', null, /must change the connector and changelog/],
  ]) {
    Git('reset', '--hard', releaseSha);
    if (text === null) {
      Git('restore', `--source=${metadata.source.sha}`, '--', file);
    } else {
      fs.writeFileSync(path.join(root, file), text);
    }
    Git('add', '--', file);
    Git('commit', '--amend', '--no-edit');
    assert.throws(
      () => VerifyCommitFiles(root, { ...metadata, release: { ...metadata.release, commitSha: Git('rev-parse', 'HEAD') } }),
      expected,
    );
  }
});

function ReadDraftReleaseWorkflow() {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'draft-release.yml'),
    'utf8',
  );
}

const request = {
  connectorVersion: '2.0.6',
  spsVersion: '9.2.0',
  supportedVersions: ['7.3', '9.2'],
  sourceBranch: 'feature/source',
  targetBranch: 'release/2026',
  changelogBody: '### Compatible SPS Versions\n\n* Feature: 7.3.0 - 9.2.0',
};
const issue = {
  number: 123,
  user: { login: 'release-author' },
  body: [
    '### Release request marker', 'safeguard-sessions-release-request-v1', '',
    '### Connector version', request.connectorVersion, '',
    '### SPS version', request.spsVersion, '',
    '### Supported versions', request.supportedVersions.join(','), '',
    '### Source branch', request.sourceBranch, '',
    '### Target branch', request.targetBranch, '',
    '### Changelog body', '', request.changelogBody,
  ].join('\n'),
};

function MakeAssets() {
  const connector = Buffer.from('connector artifact');
  const report = Buffer.from('report artifact');
  const Hash = (value) => createHash('sha256').update(value).digest('hex');
  return [
    { name: 'OneIdentitySafeguard.mez', data: connector },
    { name: 'OneIdentitySafeguard.pbit', data: report },
    { name: 'OneIdentitySafeguard.mez.sha256', data: Buffer.from(`${Hash(connector)}\n`) },
    { name: 'OneIdentitySafeguard.pbit.sha256', data: Buffer.from(`${Hash(report)}\n`) },
  ];
}

function FakeGitHub({ tagSha = null, release = null, failUploadName = null } = {}) {
  const calls = [];
  let nextAssetId = 1;
  const state = {
    tagSha,
    release: release && {
      id: 7,
      draft: true,
      tagName: 'v2.0.6+sps9.2.0',
      body: request.changelogBody,
      assets: [],
      ...release,
    },
  };
  const github = {
    async GetTag() { calls.push('getTag'); return state.tagSha && { sha: state.tagSha }; },
    async CreateTag(tag, sha) { calls.push('createTag'); state.tagSha = sha; },
    async GetRelease() { calls.push('getRelease'); return state.release; },
    async CreateDraftRelease(input) {
      calls.push(['createDraftRelease', input]);
      state.release = { id: 7, draft: true, tagName: input.tag, body: input.body, assets: [] };
      return state.release;
    },
    async DeleteAsset(id) {
      calls.push(['deleteAsset', id]);
      state.release.assets = state.release.assets.filter((asset) => asset.id !== id);
    },
    async UploadAsset(releaseId, asset) {
      calls.push(['uploadAsset', asset.name]);
      if (asset.name === failUploadName) throw new Error('simulated upload failure');
      state.release.assets.push({
        id: nextAssetId++,
        name: asset.name,
        digest: `sha256:${createHash('sha256').update(asset.data).digest('hex')}`,
      });
    },
  };
  return { github, calls, state };
}

test('draft release workflow supports pre-automation targets using authenticated trusted runs', () => {
  const workflow = ReadDraftReleaseWorkflow();
  assert.match(workflow, /^on:\r?\n  pull_request_target:\r?\n    types: \[closed\]/m);

  const locateSteps = workflow.match(
    /- name: Locate immutable preparation run\r?\n\s+id: locate\r?\n\s+shell: pwsh\r?\n\s+env:\r?\n\s+GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\r?\n\s+run: node .* locate-preparation/g,
  ) ?? [];
  assert.equal(locateSteps.length, 2);

  const exactMergedCheckouts = workflow.match(
    /- name: Checkout the exact merged commit without credentials\r?\n\s+uses: actions\/checkout@[^\r\n]+\r?\n\s+with:\r?\n\s+ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}[\s\S]*?persist-credentials: false/g,
  ) ?? [];
  assert.equal(exactMergedCheckouts.length, 2);

  const publishJob = workflow.split(/\r?\n  publish:\r?\n/)[1];
  assert.ok(publishJob);
  assert.match(publishJob, /if: github\.event\.pull_request\.merged == true/);
  assert.match(publishJob, /contents: write/);
  assert.match(publishJob, /run: node .*trusted\\Environment\\Release\\Workflow\.cjs" publish-draft/);
  assert.doesNotMatch(publishJob, /powershell\.exe.*source\\Environment/);
});

test('only current effective write-level issue author permissions are accepted', () => {
  for (const permission of ['write', 'maintain', 'admin']) {
    assert.equal(AuthorizeIssueAuthor(permission), true);
  }
  for (const permission of ['read', 'triage', 'none', null]) {
    assert.throws(() => AuthorizeIssueAuthor(permission), /write, maintain, or admin/);
  }
});

test('branch validation rejects unsafe git refs and accepts nested branch names', () => {
  assert.equal(ValidateBranchName('feature/release-2026'), true);
  for (const branch of ['', '-main', 'main..next', 'branch@{1}', 'name with space', 'a//b', 'a.lock', 'a\\b']) {
    assert.throws(() => ValidateBranchName(branch), /valid Git branch/);
  }
});

test('preparation pins both selected refs and rejects existing tags and duplicate requests', async () => {
  const available = {
    async GetPermission() { return 'write'; },
    async GetBranch(name) { return name === request.sourceBranch ? 'a'.repeat(40) : 'b'.repeat(40); },
    async GetTag() { return null; },
    async GetRelease() { return null; },
    async FindDuplicateRequest() { return false; },
    async FindConflictingBranch() { return false; },
  };
  const plan = await CreatePreparationPlan({
    issue, repository: 'davedusa/SafeguardPowerBI', defaultBranch: 'main',
    runId: 987, runAttempt: 1, github: available,
  });
  assert.equal(plan.source.sha, 'a'.repeat(40));
  assert.equal(plan.target.sha, 'b'.repeat(40));
  assert.equal(plan.request.sourceBranch, request.sourceBranch);
  assert.match(plan.release.branch, /^release\/sessions\/v2\.0\.6-sps9\.2\.0-issue-123-run-987-attempt-1$/);

  const mainAsSourceAndTarget = {
    ...issue,
    body: issue.body.replace('### Source branch\nfeature/source', '### Source branch\nmain')
      .replace('### Target branch\nrelease/2026', '### Target branch\nmain'),
  };
  const mainPlan = await CreatePreparationPlan({
    issue: mainAsSourceAndTarget, repository: 'davedusa/SafeguardPowerBI',
    defaultBranch: 'main', runId: 988, runAttempt: 1, github: available,
  });
  assert.equal(mainPlan.source.branch, 'main');
  assert.equal(mainPlan.target.branch, 'main');

  await assert.rejects(
    CreatePreparationPlan({
      issue, repository: 'davedusa/SafeguardPowerBI', defaultBranch: 'main',
      runId: 987, runAttempt: 1,
      github: { ...available, async GetPermission() { return 'triage'; } },
    }),
    /write, maintain, or admin/,
  );
  await assert.rejects(
    CreatePreparationPlan({
      issue: { ...issue, body: issue.body.replace('feature/source', 'bad..branch') },
      repository: 'davedusa/SafeguardPowerBI', defaultBranch: 'main',
      runId: 987, runAttempt: 1, github: available,
    }),
    /valid Git branch/,
  );
  await assert.rejects(
    CreatePreparationPlan({
      issue, repository: 'davedusa/SafeguardPowerBI', defaultBranch: 'main',
      runId: 987, runAttempt: 1,
      github: { ...available, async GetTag() { return { sha: 'c'.repeat(40) }; } },
    }),
    /already exists/,
  );
  await assert.rejects(
    CreatePreparationPlan({
      issue, repository: 'davedusa/SafeguardPowerBI', defaultBranch: 'main',
      runId: 987, runAttempt: 1,
      github: { ...available, async FindDuplicateRequest() { return true; } },
    }),
    /duplicate or already processed/,
  );
});

test('preparation metadata must bind the trusted run, PR head, target, and merged commit', () => {
  const metadata = {
    schemaVersion: 1,
    repository: 'davedusa/SafeguardPowerBI',
    workflowPath: '.github/workflows/prepare-release.yml',
    automationSha: 'd'.repeat(40),
    runId: 987,
    runAttempt: 1,
    issueNumber: 123,
    request,
    source: { branch: request.sourceBranch, sha: 'a'.repeat(40) },
    target: { branch: request.targetBranch, sha: 'b'.repeat(40) },
    release: {
      tag: 'v2.0.6+sps9.2.0',
      branch: 'release/sessions/v2.0.6-sps9.2.0-issue-123-run-987-attempt-1',
      commitSha: 'c'.repeat(40),
    },
  };
  const run = {
    id: 987, run_attempt: 1, event: 'issues', conclusion: 'success',
    path: '.github/workflows/prepare-release.yml',
    head_branch: 'main', head_sha: metadata.automationSha, workflow_id: 44,
  };
  const pullRequest = {
    number: 456, state: 'closed', merged: true,
    head: { ref: metadata.release.branch, sha: metadata.release.commitSha, repo: { full_name: metadata.repository } },
    base: { ref: request.targetBranch },
    merge_commit_sha: 'e'.repeat(40),
  };

  assert.equal(ValidatePreparationMetadata(metadata, { run, pullRequest, repository: metadata.repository, workflowId: 44 }), true);
  assert.throws(
    () => ValidatePreparationMetadata(metadata, {
      run, pullRequest: { ...pullRequest, head: { ...pullRequest.head, sha: 'f'.repeat(40) } },
      repository: metadata.repository, workflowId: 44,
    }),
    /prepared PR head/,
  );
  assert.throws(
    () => ValidatePreparationMetadata(metadata, {
      run: { ...run, event: 'workflow_dispatch' }, pullRequest,
      repository: metadata.repository, workflowId: 44,
    }),
    /trusted preparation run/,
  );
  assert.throws(
    () => ValidatePreparationMetadata(metadata, {
      run, pullRequest, repository: metadata.repository, workflowId: 44,
      mergedSha: 'f'.repeat(40),
    }),
    /event snapshot/,
  );
  assert.throws(
    () => ValidatePreparationMetadata(metadata, {
      run, pullRequest: { ...pullRequest, merged: false },
      repository: metadata.repository, workflowId: 44,
    }),
    /was not merged/,
  );
});

test('publication metadata must match the preflight snapshot and checked commit output', () => {
  const expectedPlan = {
    schemaVersion: 1,
    repository: 'davedusa/SafeguardPowerBI',
    workflowPath: '.github/workflows/prepare-release.yml',
    automationSha: 'd'.repeat(40),
    runId: 987,
    runAttempt: 1,
    issueNumber: 123,
    issueAuthor: 'release-author',
    request,
    source: { branch: request.sourceBranch, sha: 'a'.repeat(40) },
    target: { branch: request.targetBranch, sha: 'b'.repeat(40) },
    release: { tag: 'v2.0.6+sps9.2.0', branch: 'release/sessions/v2.0.6-sps9.2.0-issue-123-run-987-attempt-1', commitSha: null },
  };
  const metadata = {
    ...expectedPlan,
    runAttempt: 2,
    release: {
      ...expectedPlan.release,
      branch: 'release/sessions/v2.0.6-sps9.2.0-issue-123-run-987-attempt-2',
      commitSha: 'c'.repeat(40),
    },
  };
  const context = {
    repository: expectedPlan.repository,
    runId: expectedPlan.runId,
    runAttempt: 2,
    commitSha: metadata.release.commitSha,
  };

  assert.equal(ValidatePreparedArtifact(metadata, expectedPlan, context), true);
  assert.throws(
    () => ValidatePreparedArtifact({ ...metadata, request: { ...request, connectorVersion: '2.0.7' } }, expectedPlan, context),
    /preflight snapshot/,
  );
  assert.throws(
    () => ValidatePreparedArtifact(metadata, expectedPlan, { ...context, commitSha: 'f'.repeat(40) }),
    /checked release commit/,
  );
});

test('draft publication checks all assets before tagging and safely resumes failed uploads', async () => {
  const assets = MakeAssets();
  const partial = FakeGitHub({ failUploadName: 'OneIdentitySafeguard.pbit' });
  const args = {
    tag: 'v2.0.6+sps9.2.0',
    mergedSha: 'e'.repeat(40),
    targetBranch: request.targetBranch,
    notes: request.changelogBody,
    assets,
    github: partial.github,
  };

  await assert.rejects(PublishDraftRelease(args), /simulated upload failure/);
  assert.equal(partial.state.tagSha, 'e'.repeat(40));
  assert.equal(partial.state.release.draft, true);
  assert.deepEqual(partial.state.release.assets.map((asset) => asset.name), ['OneIdentitySafeguard.mez']);
  assert.equal(partial.calls.filter((call) => Array.isArray(call) && call[0] === 'createDraftRelease').length, 1);

  partial.github.UploadAsset = async (releaseId, asset) => {
    partial.calls.push(['uploadAsset', asset.name]);
    partial.state.release.assets.push({
      id: 20 + partial.state.release.assets.length,
      name: asset.name,
      digest: `sha256:${createHash('sha256').update(asset.data).digest('hex')}`,
    });
  };
  const resumed = await PublishDraftRelease(args);
  assert.equal(resumed.draft, true);
  assert.equal(partial.calls.filter((call) => call === 'createTag').length, 1);
  assert.equal(partial.calls.filter((call) => Array.isArray(call) && call[0] === 'createDraftRelease').length, 1);
  assert.deepEqual(
    partial.state.release.assets.map((asset) => asset.name).sort(),
    assets.map((asset) => asset.name).sort(),
  );
});

test('draft publication rejects conflicting tags, public releases, and corrupt assets before tag creation', async () => {
  const assets = MakeAssets();
  const malformedTag = FakeGitHub();
  await assert.rejects(PublishDraftRelease({
    tag: 'release-2.0.6', mergedSha: 'e'.repeat(40), targetBranch: request.targetBranch,
    notes: request.changelogBody, assets, github: malformedTag.github,
  }), /tag is invalid/);
  assert.equal(malformedTag.calls.includes('createTag'), false);

  const conflictingTag = FakeGitHub({ tagSha: 'f'.repeat(40) });
  await assert.rejects(PublishDraftRelease({
    tag: 'v2.0.6+sps9.2.0', mergedSha: 'e'.repeat(40), targetBranch: request.targetBranch,
    notes: request.changelogBody, assets, github: conflictingTag.github,
  }), /points to a different commit/);
  assert.equal(conflictingTag.calls.includes('createTag'), false);

  const published = FakeGitHub({ release: { draft: false } });
  await assert.rejects(PublishDraftRelease({
    tag: 'v2.0.6+sps9.2.0', mergedSha: 'e'.repeat(40), targetBranch: request.targetBranch,
    notes: request.changelogBody, assets, github: published.github,
  }), /already public/);
  assert.equal(published.calls.includes('createTag'), false);

  const conflictingDraft = FakeGitHub({ release: { body: 'edited notes' } });
  await assert.rejects(PublishDraftRelease({
    tag: 'v2.0.6+sps9.2.0', mergedSha: 'e'.repeat(40), targetBranch: request.targetBranch,
    notes: request.changelogBody, assets, github: conflictingDraft.github,
  }), /conflicts with the expected release notes/);
  assert.equal(conflictingDraft.calls.includes('createTag'), false);

  const corrupt = FakeGitHub();
  const damagedAssets = [...assets];
  damagedAssets[2] = { ...damagedAssets[2], data: Buffer.from('incorrect checksum') };
  await assert.rejects(PublishDraftRelease({
    tag: 'v2.0.6+sps9.2.0', mergedSha: 'e'.repeat(40), targetBranch: request.targetBranch,
    notes: request.changelogBody, assets: damagedAssets, github: corrupt.github,
  }), /checksum asset/);
  assert.equal(corrupt.calls.includes('createTag'), false);
});
