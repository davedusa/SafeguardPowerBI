'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
} = require('./Workflow.cjs');

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
