'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ParseRequest,
  ValidateRequest,
  UpdateReleaseFiles,
  VerifyReleaseFiles,
} = require('./Request.cjs');

const WORKFLOW_PATH = '.github/workflows/prepare-release.yml';
const RELEASE_PATHS = Object.freeze([
  '.github/ISSUE_TEMPLATE/release-request.yml',
  'SafeguardSessions/Src/SafeguardSessions.pq',
  'SafeguardSessions/Src/Modules/Version/SupportedVersions.pqm',
  'SafeguardSessions/CHANGELOG.md',
]);
const ASSET_PATHS = Object.freeze({
  'OneIdentitySafeguard.mez': 'SafeguardSessions/Deploy/OneIdentitySafeguard/Bin/OneIdentitySafeguard.mez',
  'OneIdentitySafeguard.pbit': 'SafeguardSessions/ReportTemplates/OneIdentitySafeguard.pbit',
  'OneIdentitySafeguard.mez.sha256': 'SafeguardSessions/Deploy/OneIdentitySafeguard/Bin/OneIdentitySafeguard.mez.sha256',
  'OneIdentitySafeguard.pbit.sha256': 'SafeguardSessions/ReportTemplates/OneIdentitySafeguard.pbit.sha256',
});
const HEX_SHA = /^[a-f0-9]{40}$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\+sps(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function Assert(condition, message) {
  if (!condition) throw new Error(message);
}

function AuthorizeIssueAuthor(permission) {
  if (!['write', 'maintain', 'admin'].includes(permission)) {
    throw new Error('Release request author must currently have write, maintain, or admin repository permission');
  }
  return true;
}

function ValidateBranchName(branch) {
  const validText = typeof branch === 'string'
    && branch.length > 0
    && !branch.startsWith('-')
    && !/[\u0000-\u0020\u007f~^:?*\\[\]]/.test(branch)
    && !branch.includes('..')
    && !branch.includes('@{')
    && !branch.includes('//')
    && branch !== '@'
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && branch.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
  if (!validText) throw new Error('Branch name is not a valid Git branch');

  const result = spawnSync('git', ['check-ref-format', '--branch', branch], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Branch name is not a valid Git branch');
  }
  return true;
}

function ReleaseTag(request) {
  return `v${request.connectorVersion}+sps${request.spsVersion}`;
}

function ReleaseBranch(request, issueNumber, runId, runAttempt) {
  return `release/sessions/v${request.connectorVersion}-sps${request.spsVersion}-issue-${issueNumber}-run-${runId}-attempt-${runAttempt}`;
}

async function CreatePreparationPlan({
  issue,
  repository,
  defaultBranch,
  runId,
  runAttempt,
  automationSha,
  github,
}) {
  Assert(issue && Number.isSafeInteger(issue.number), 'Issue event has no valid issue number');
  Assert(issue.user && typeof issue.user.login === 'string', 'Issue event has no author');
  Assert(typeof issue.body === 'string', 'Issue event has no body snapshot');
  Assert(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Repository name is invalid');
  Assert(typeof defaultBranch === 'string', 'Repository default branch is missing');
  ValidateBranchName(defaultBranch);
  Assert(Number.isSafeInteger(runId) && runId > 0, 'Workflow run ID is invalid');
  Assert(Number.isSafeInteger(runAttempt) && runAttempt > 0, 'Workflow run attempt is invalid');
  if (automationSha !== undefined) Assert(HEX_SHA.test(automationSha), 'Trusted automation SHA is invalid');
  Assert(github && typeof github.GetPermission === 'function', 'GitHub API adapter is required');

  const request = ParseRequest(issue.body);
  const validation = ValidateRequest(request);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  ValidateBranchName(request.sourceBranch);
  ValidateBranchName(request.targetBranch);

  const permission = await github.GetPermission(issue.user.login);
  AuthorizeIssueAuthor(permission);

  const [sourceSha, targetSha] = await Promise.all([
    github.GetBranch(request.sourceBranch),
    github.GetBranch(request.targetBranch),
  ]);
  Assert(HEX_SHA.test(sourceSha), `Source branch '${request.sourceBranch}' does not exist or has an invalid commit`);
  Assert(HEX_SHA.test(targetSha), `Target branch '${request.targetBranch}' does not exist or has an invalid commit`);

  const tag = ReleaseTag(request);
  const branch = ReleaseBranch(request, issue.number, runId, runAttempt);
  const versionPrefix = `release/sessions/v${request.connectorVersion}-sps${request.spsVersion}`;
  const [existingTag, existingRelease, duplicateRequest, conflictingBranch] = await Promise.all([
    github.GetTag(tag),
    github.GetRelease(tag),
    github.FindDuplicateRequest(tag, issue.number),
    github.FindConflictingBranch(versionPrefix, `release/sessions/issue-${issue.number}-`),
  ]);
  if (existingTag || existingRelease) throw new Error(`Release tag '${tag}' or its release already exists`);
  if (duplicateRequest || conflictingBranch) throw new Error(`A duplicate or already processed release request exists for '${tag}'`);

  return {
    schemaVersion: 1,
    repository,
    workflowPath: WORKFLOW_PATH,
    automationSha: automationSha ?? null,
    runId,
    runAttempt,
    issueNumber: issue.number,
    issueAuthor: issue.user.login,
    request,
    source: { branch: request.sourceBranch, sha: sourceSha },
    target: { branch: request.targetBranch, sha: targetSha },
    release: { tag, branch, commitSha: null },
  };
}

function ValidatePreparationMetadata(metadata, {
  run,
  pullRequest,
  repository,
  workflowId,
  mergedSha,
  defaultBranch,
} = {}) {
  Assert(metadata && metadata.schemaVersion === 1, 'Preparation metadata schema is invalid');
  Assert(metadata.repository === repository, 'Preparation metadata repository does not match');
  Assert(metadata.workflowPath === WORKFLOW_PATH, 'Preparation metadata workflow path is invalid');
  Assert(HEX_SHA.test(metadata.automationSha), 'Preparation metadata trusted automation SHA is invalid');
  Assert(Number.isSafeInteger(metadata.runId) && Number.isSafeInteger(metadata.runAttempt), 'Preparation metadata run identity is invalid');
  Assert(Number.isSafeInteger(metadata.issueNumber), 'Preparation metadata issue number is invalid');
  const validation = ValidateRequest(metadata.request);
  Assert(validation.valid, `Preparation metadata request is invalid: ${validation.errors.join('; ')}`);
  Assert(metadata.source?.branch === metadata.request.sourceBranch && HEX_SHA.test(metadata.source.sha), 'Preparation metadata source ref is invalid');
  Assert(metadata.target?.branch === metadata.request.targetBranch && HEX_SHA.test(metadata.target.sha), 'Preparation metadata target ref is invalid');
  ValidateBranchName(metadata.source.branch);
  ValidateBranchName(metadata.target.branch);
  Assert(metadata.release?.tag === ReleaseTag(metadata.request) && RELEASE_TAG.test(metadata.release.tag), 'Preparation metadata release tag is invalid');
  ValidateBranchName(metadata.release.branch);
  Assert(metadata.release.commitSha && HEX_SHA.test(metadata.release.commitSha), 'Preparation metadata release commit is invalid');
  Assert(metadata.release.branch === ReleaseBranch(metadata.request, metadata.issueNumber, metadata.runId, metadata.runAttempt), 'Preparation metadata release branch is invalid');

  Assert(run && run.id === metadata.runId && run.run_attempt === metadata.runAttempt, 'PR does not originate from the trusted preparation run');
  Assert(run.event === 'issues' && run.conclusion === 'success', 'PR does not originate from a successful trusted preparation run');
  Assert(run.workflow_id === workflowId, 'PR does not originate from the trusted preparation workflow');
  Assert(typeof run.path === 'string'
    && (run.path === WORKFLOW_PATH || run.path.startsWith(`${WORKFLOW_PATH}@`)), 'PR does not originate from the trusted preparation workflow');
  Assert(run.head_sha === metadata.automationSha, 'Preparation run used a different trusted automation revision');
  if (defaultBranch) Assert(run.head_branch === defaultBranch, 'Preparation run did not use the repository default branch');

  Assert(pullRequest && pullRequest.merged === true && pullRequest.state === 'closed', 'Release PR was not merged');
  Assert(pullRequest.number > 0, 'Release PR number is invalid');
  Assert(pullRequest.head?.ref === metadata.release.branch, 'Merged PR head branch does not match preparation metadata');
  Assert(pullRequest.head?.sha === metadata.release.commitSha, 'Merged PR head SHA does not match the prepared PR head');
  Assert(pullRequest.head?.repo?.full_name === repository, 'Merged PR head repository does not match');
  Assert(pullRequest.base?.ref === metadata.target.branch, 'Merged PR target branch does not match preparation metadata');
  Assert(HEX_SHA.test(pullRequest.merge_commit_sha), 'Merged PR has no valid exact merge commit');
  if (mergedSha !== undefined) Assert(pullRequest.merge_commit_sha === mergedSha, 'Merged PR commit does not match the event snapshot');
  return true;
}

function ValidatePreparedArtifact(metadata, preflightPlan, {
  repository,
  runId,
  runAttempt,
  commitSha,
} = {}) {
  Assert(metadata && preflightPlan, 'Preparation artifact or preflight snapshot is missing');
  Assert(metadata.repository === repository && preflightPlan.repository === repository, 'Preparation artifact belongs to another repository');
  Assert(metadata.runId === runId && preflightPlan.runId === runId, 'Preparation artifact belongs to another workflow run');
  Assert(metadata.runAttempt === runAttempt, 'Preparation artifact belongs to another workflow run attempt');
  for (const field of ['schemaVersion', 'workflowPath', 'automationSha', 'issueNumber', 'issueAuthor']) {
    Assert(metadata[field] === preflightPlan[field], `Preparation artifact does not match the preflight snapshot (${field})`);
  }
  Assert(JSON.stringify(metadata.request) === JSON.stringify(preflightPlan.request)
    && JSON.stringify(metadata.source) === JSON.stringify(preflightPlan.source)
    && JSON.stringify(metadata.target) === JSON.stringify(preflightPlan.target),
  'Preparation artifact does not match the preflight snapshot');
  Assert(metadata.release?.tag === preflightPlan.release?.tag, 'Preparation artifact does not match the preflight snapshot (release tag)');
  Assert(HEX_SHA.test(commitSha) && metadata.release?.commitSha === commitSha, 'Preparation artifact does not match the checked release commit');
  Assert(metadata.release.branch === ReleaseBranch(metadata.request, metadata.issueNumber, runId, runAttempt), 'Preparation artifact release branch is invalid');
  return true;
}

function ValidateReleaseAssets(assets) {
  Assert(Array.isArray(assets) && assets.length === 4, 'Exactly four release assets are required');
  const byName = new Map();
  for (const asset of assets) {
    Assert(asset && typeof asset.name === 'string' && Buffer.isBuffer(asset.data), 'Release asset data is invalid');
    Assert(asset.data.length > 0, `Release asset '${asset.name}' is empty`);
    Assert(Object.hasOwn(ASSET_PATHS, asset.name), `Unexpected release asset '${asset.name}'`);
    Assert(!byName.has(asset.name), `Duplicate release asset '${asset.name}'`);
    byName.set(asset.name, asset);
  }
  Assert([...byName.keys()].length === Object.keys(ASSET_PATHS).length, 'One or more required release assets are missing');
  for (const [assetName, checksumName] of [
    ['OneIdentitySafeguard.mez', 'OneIdentitySafeguard.mez.sha256'],
    ['OneIdentitySafeguard.pbit', 'OneIdentitySafeguard.pbit.sha256'],
  ]) {
    const expected = createHash('sha256').update(byName.get(assetName).data).digest('hex');
    const supplied = byName.get(checksumName).data.toString('utf8').trim();
    Assert(/^[a-f0-9]{64}$/.test(supplied) && supplied === expected, `Release checksum asset '${checksumName}' does not match`);
  }
  return byName;
}

function AssetDigest(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function PublishDraftRelease({
  tag,
  mergedSha,
  targetBranch,
  notes,
  assets,
  github,
}) {
  Assert(RELEASE_TAG.test(tag), 'Release tag is invalid');
  Assert(HEX_SHA.test(mergedSha), 'Merged commit SHA is invalid');
  ValidateBranchName(targetBranch);
  Assert(typeof notes === 'string' && notes.trim() !== '', 'Release notes are empty');
  Assert(github && typeof github.GetTag === 'function', 'GitHub API adapter is required');
  const assetByName = ValidateReleaseAssets(assets);

  let existingTag = await github.GetTag(tag);
  if (existingTag && existingTag.sha !== mergedSha) {
    throw new Error(`Existing tag '${tag}' points to a different commit`);
  }

  let release = await github.GetRelease(tag);
  if (release && release.draft !== true) throw new Error(`Release '${tag}' is already public`);
  if (release && (release.tagName !== tag || release.body !== notes)) {
    throw new Error(`Existing draft release '${tag}' conflicts with the expected release notes`);
  }

  if (!existingTag) {
    try {
      await github.CreateTag(tag, mergedSha);
    } catch (error) {
      existingTag = await github.GetTag(tag);
      if (!existingTag || existingTag.sha !== mergedSha) throw error;
    }
  }
  if (!release) {
    release = await github.CreateDraftRelease({
      tag,
      name: tag,
      targetCommitish: targetBranch,
      body: notes,
      draft: true,
    });
  }
  Assert(release && release.draft === true, 'GitHub did not create or return a draft release');

  const existingAssets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  for (const [name, asset] of assetByName) {
    const current = existingAssets.get(name);
    const expectedDigest = AssetDigest(asset.data);
    if (current && current.digest === expectedDigest) continue;
    if (current) await github.DeleteAsset(current.id);
    await github.UploadAsset(release.id, asset);
  }
  return { id: release.id, tag, draft: true, mergedSha };
}

function Git(cwd, args, { allowFailure = false, input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function Gh(args, { allowFailure = false, input } = {}) {
  const result = spawnSync('gh', ['api', ...args], {
    encoding: 'utf8',
    input,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`gh api failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function ApiGet(endpoint, { notFound = false } = {}) {
  const result = Gh(['--include', endpoint], { allowFailure: notFound });
  const statusLine = result.stdout.split(/\r?\n/, 1)[0] ?? '';
  const status = Number(/\s(\d{3})\s/.exec(statusLine)?.[1]);
  if (result.status !== 0) {
    if (notFound && (status === 404 || /\b404\b/.test(`${result.stdout}\n${result.stderr}`))) return null;
    throw new Error((result.stderr || result.stdout || 'GitHub API request failed').trim());
  }
  if (notFound && status === 404) return null;
  Assert(!Number.isFinite(status) || status < 400, `GitHub API returned HTTP ${status} for '${endpoint}'`);
  const boundary = result.stdout.indexOf('\r\n\r\n');
  const fallbackBoundary = result.stdout.indexOf('\n\n');
  const splitAt = boundary >= 0 ? boundary : fallbackBoundary;
  Assert(splitAt >= 0, `GitHub API returned no JSON body for '${endpoint}'`);
  return JSON.parse(result.stdout.slice(splitAt + (boundary >= 0 ? 4 : 2)));
}

function WriteOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  Assert(output, 'GITHUB_OUTPUT is not set');
  fs.appendFileSync(output, `${name}=${value}\n`, 'utf8');
}

function WriteSummary(text) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${text}\n`, 'utf8');
}

function ReadEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  Assert(eventPath, 'GITHUB_EVENT_PATH is not set');
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function ParseEncodedPlan(encoded, name) {
  Assert(encoded, `${name} is not set`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function ParsePlan() {
  return ParseEncodedPlan(process.env.RELEASE_PLAN, 'RELEASE_PLAN');
}

function Repo() {
  const value = process.env.GITHUB_REPOSITORY;
  Assert(value, 'GITHUB_REPOSITORY is not set');
  return value;
}

function EncodedRepository(repository) {
  const parts = repository.split('/');
  Assert(parts.length === 2 && parts.every((part) => part.length > 0), 'Repository name is invalid');
  return parts.map(encodeURIComponent).join('/');
}

function EncodedGitRef(ref) {
  return encodeURIComponent(ref).replaceAll('%2F', '/');
}

function NormalizeTag(result, GetAnnotatedTag) {
  let object = result.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
    object = GetAnnotatedTag(object.sha);
  }
  return object?.type === 'commit' ? { sha: object.sha } : { sha: null };
}

function NormalizeRelease(release) {
  return {
    id: release.id,
    draft: release.draft,
    tagName: release.tag_name,
    body: release.body,
    assets: (release.assets ?? []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      digest: asset.digest,
    })),
  };
}

function GitHubAdapter(repository) {
  const repoPath = EncodedRepository(repository);
  const Ref = (type, name) => `repos/${repoPath}/git/ref/${type}/${EncodedGitRef(name)}`;
  const ReleaseByTag = (tag) => `repos/${repoPath}/releases/tags/${encodeURIComponent(tag)}`;
  return {
    async GetPermission(login) {
      const result = ApiGet(`repos/${repoPath}/collaborators/${encodeURIComponent(login)}/permission`);
      return result.permission;
    },
    async GetBranch(name) {
      const result = ApiGet(Ref('heads', name), { notFound: true });
      return result?.object?.sha ?? null;
    },
    async GetTag(name) {
      const result = ApiGet(Ref('tags', name), { notFound: true });
      if (!result) return null;
      return NormalizeTag(result, (sha) => ApiGet(`repos/${repoPath}/git/tags/${sha}`).object);
    },
    async GetRelease(tag) {
      const result = ApiGet(ReleaseByTag(tag), { notFound: true });
      if (!result) return null;
      return NormalizeRelease(result);
    },
    async FindDuplicateRequest(tag, issueNumber) {
      const [connectorVersion, spsVersion] = tag.slice(1).split('+sps');
      const query = encodeURIComponent(`repo:${repository} is:issue is:open "safeguard-sessions-release-request-v1" "${connectorVersion}" "${spsVersion}"`);
      const result = ApiGet(`search/issues?q=${query}&per_page=100`);
      return result.items.some((candidate) => candidate.number !== issueNumber);
    },
    async FindConflictingBranch(versionPrefix, issuePrefix) {
      const versionRefs = ApiGet(`repos/${repoPath}/git/matching-refs/heads/${EncodedGitRef(versionPrefix)}`);
      const issueRefs = ApiGet(`repos/${repoPath}/git/matching-refs/heads/${EncodedGitRef(issuePrefix)}`);
      return versionRefs.some((item) => item.ref.startsWith(`refs/heads/${versionPrefix}`))
        || issueRefs.some((item) => item.ref.startsWith(`refs/heads/${issuePrefix}`));
    },
  };
}

function ReadReleaseFiles(root) {
  return {
    connector: fs.readFileSync(path.join(root, 'SafeguardSessions', 'Src', 'SafeguardSessions.pq'), 'utf8'),
    supportedVersions: fs.readFileSync(path.join(root, 'SafeguardSessions', 'Src', 'Modules', 'Version', 'SupportedVersions.pqm'), 'utf8'),
    changelog: fs.readFileSync(path.join(root, 'SafeguardSessions', 'CHANGELOG.md'), 'utf8'),
    form: fs.readFileSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'release-request.yml'), 'utf8'),
  };
}

function ValidateSessionsConfig(root) {
  const configPath = path.join(root, 'SafeguardSessions', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const Normalized = (value) => typeof value === 'string' ? value.replaceAll('\\', '/') : '';
  Assert(Normalized(config.ConnectorMezPath) === 'Deploy/OneIdentitySafeguard/Bin/OneIdentitySafeguard.mez', 'Sessions config connector asset path is not the expected release path');
  const reportPaths = Object.values(config.ReportTemplatePaths ?? {}).map(Normalized);
  Assert(reportPaths.length === 1 && reportPaths[0] === 'ReportTemplates/OneIdentitySafeguard.pbit', 'Sessions config report asset path is not the expected release path');
  return true;
}

function VerifyFormDefaults(form, request) {
  const expected = {
    release_request_marker: 'safeguard-sessions-release-request-v1',
    connector_version: request.connectorVersion,
    sps_version: request.spsVersion,
    supported_versions: request.supportedVersions.join(','),
    changelog_body: request.changelogBody,
    source_branch: 'main',
    target_branch: 'main',
  };
  const lines = form.split(/\r?\n/);
  for (const [id, value] of Object.entries(expected)) {
    const fields = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== `id: ${id}`) continue;
      const end = lines.findIndex((line, candidate) => candidate > index && /^  - type:/.test(line));
      const fieldLines = lines.slice(index + 1, end < 0 ? lines.length : end);
      const valueLines = fieldLines.filter((line) => /^\s*value:/.test(line));
      fields.push(valueLines.length === 1 ? valueLines[0].replace(/^\s*value:\s*/, '') : null);
    }
    Assert(fields.length === 1 && fields[0] !== null, `Release issue form must contain exactly one ${id} default`);
    let actual;
    try {
      actual = JSON.parse(fields[0]);
    } catch {
      throw new Error(`Release issue form ${id} default is not a JSON-quoted string`);
    }
    Assert(actual === value, `Release issue form ${id} default does not match the merged release`);
  }
  return true;
}

function ReadGitFile(root, commit, file) {
  return Git(root, ['show', `${commit}:${file}`]).stdout;
}

function VerifyReleasePaths(changed, description) {
  Assert(changed.every((file) => RELEASE_PATHS.includes(file)), `${description} includes files outside the four approved release paths`);
  const required = [
    'SafeguardSessions/Src/SafeguardSessions.pq',
    'SafeguardSessions/CHANGELOG.md',
  ];
  Assert(required.every((file) => changed.includes(file)), `${description} must change the connector and changelog`);
}

function VerifyCommitFiles(root, plan) {
  const changed = Git(root, ['diff', '--name-only', `${plan.source.sha}..${plan.release.commitSha}`])
    .stdout.split(/\r?\n/).filter(Boolean).sort();
  VerifyReleasePaths(changed, 'Prepared release commit');

  const files = {
    connector: ReadGitFile(root, plan.release.commitSha, 'SafeguardSessions/Src/SafeguardSessions.pq'),
    supportedVersions: ReadGitFile(root, plan.release.commitSha, 'SafeguardSessions/Src/Modules/Version/SupportedVersions.pqm'),
    changelog: ReadGitFile(root, plan.release.commitSha, 'SafeguardSessions/CHANGELOG.md'),
    form: ReadGitFile(root, plan.release.commitSha, '.github/ISSUE_TEMPLATE/release-request.yml'),
  };
  const verified = VerifyReleaseFiles(files, plan.request);
  Assert(verified.valid, `Prepared release files are invalid: ${verified.errors.join('; ')}`);
  VerifyFormDefaults(files.form, plan.request);
  return { files, notes: verified.notes };
}

function ApiRequest(repository, endpoint, { method = 'GET', body, allowFailure = false } = {}) {
  const args = ['--include', '--method', method, endpoint];
  if (body !== undefined) args.push('--input', '-');
  const result = Gh(args, {
    allowFailure,
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  const boundary = result.stdout.indexOf('\r\n\r\n');
  const fallbackBoundary = result.stdout.indexOf('\n\n');
  const splitAt = boundary >= 0 ? boundary : fallbackBoundary;
  const statusLine = result.stdout.split(/\r?\n/, 1)[0] ?? '';
  const status = Number(/\s(\d{3})\s/.exec(statusLine)?.[1]);
  if (allowFailure && (result.status !== 0 || status >= 400)) {
    const failureText = `${result.stdout}\n${result.stderr}`;
    if (status === 404 || /\bHTTP(?:\/\S+)?\s+404\b|\bHTTP 404\b/.test(failureText)) return { status: 404, body: null };
    return { status: Number.isFinite(status) ? status : 500, body: null };
  }
  Assert(result.status === 0 && splitAt >= 0 && status < 400, `GitHub API ${method} ${endpoint} failed: ${(result.stderr || result.stdout).trim()}`);
  const text = result.stdout.slice(splitAt + (boundary >= 0 ? 4 : 2));
  return { status, body: text ? JSON.parse(text) : null };
}

function MakePublisher(repository) {
  const repoPath = EncodedRepository(repository);
  const RefPath = (type, name) => `repos/${repoPath}/git/ref/${type}/${EncodedGitRef(name)}`;
  const ReleasePath = (tag) => `repos/${repoPath}/releases/tags/${encodeURIComponent(tag)}`;
  return {
    async GetTag(tag) {
      const result = ApiRequest(repository, RefPath('tags', tag), { allowFailure: true });
      if (result.status === 404) return null;
      Assert(result.status < 400, `Could not read tag '${tag}'`);
      return NormalizeTag(result.body, (sha) => ApiRequest(repository, `repos/${repoPath}/git/tags/${sha}`).body.object);
    },
    async CreateTag(tag, sha) {
      const response = ApiRequest(repository, `repos/${repoPath}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/tags/${tag}`, sha },
        allowFailure: true,
      });
      if (response.status >= 400) throw new Error(`Could not create release tag '${tag}' (HTTP ${response.status})`);
    },
    async GetRelease(tag) {
      const response = ApiRequest(repository, ReleasePath(tag), { allowFailure: true });
      if (response.status === 404) return null;
      Assert(response.status < 400, `Could not read release '${tag}'`);
      return NormalizeRelease(response.body);
    },
    async CreateDraftRelease(input) {
      const response = ApiRequest(repository, `repos/${repoPath}/releases`, {
        method: 'POST',
        body: {
          tag_name: input.tag,
          name: input.name,
          target_commitish: input.targetCommitish,
          body: input.body,
          draft: true,
          prerelease: false,
        },
      });
      return {
        id: response.body.id,
        draft: response.body.draft,
        tagName: response.body.tag_name,
        body: response.body.body,
        assets: [],
      };
    },
    async DeleteAsset(id) {
      const response = ApiRequest(repository, `repos/${repoPath}/releases/assets/${id}`, {
        method: 'DELETE',
        allowFailure: true,
      });
      Assert(response.status === 204, `Could not replace conflicting release asset ${id}`);
    },
    async UploadAsset(releaseId, asset) {
      const token = process.env.GH_TOKEN;
      Assert(token, 'GH_TOKEN is not available for release asset upload');
      const url = `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: asset.data,
      });
      if (!response.ok) throw new Error(`Uploading '${asset.name}' failed (HTTP ${response.status}): ${(await response.text()).slice(0, 1000)}`);
    },
  };
}

async function Preflight() {
  const event = ReadEvent();
  const repository = Repo();
  const plan = await CreatePreparationPlan({
    issue: event.issue,
    repository,
    defaultBranch: event.repository?.default_branch,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    automationSha: process.env.GITHUB_SHA,
    github: GitHubAdapter(repository),
  });
  WriteOutput('plan', Buffer.from(JSON.stringify(plan)).toString('base64'));
  WriteOutput('source_sha', plan.source.sha);
  WriteSummary(`Release request #${plan.issueNumber} passed authorization, field, ref, duplicate, and tag checks.\n\n- Source: \`${plan.source.branch}\` at \`${plan.source.sha}\`\n- Target: \`${plan.target.branch}\` at \`${plan.target.sha}\`\n- Tag: \`${plan.release.tag}\``);
}

function WriteReleaseFiles() {
  const plan = ParsePlan();
  const root = process.env.SOURCE_DIRECTORY;
  const trusted = process.env.TRUSTED_DIRECTORY;
  Assert(root && trusted, 'Source and trusted directories must be set');
  ValidateSessionsConfig(root);
  const current = {
    connector: fs.readFileSync(path.join(root, 'SafeguardSessions', 'Src', 'SafeguardSessions.pq'), 'utf8'),
    supportedVersions: fs.readFileSync(path.join(root, 'SafeguardSessions', 'Src', 'Modules', 'Version', 'SupportedVersions.pqm'), 'utf8'),
    changelog: fs.readFileSync(path.join(root, 'SafeguardSessions', 'CHANGELOG.md'), 'utf8'),
    form: fs.readFileSync(path.join(trusted, '.github', 'ISSUE_TEMPLATE', 'release-request.yml'), 'utf8'),
  };
  const updated = UpdateReleaseFiles(current, plan.request, new Date().toISOString().slice(0, 10));
  const destinations = {
    connector: 'SafeguardSessions/Src/SafeguardSessions.pq',
    supportedVersions: 'SafeguardSessions/Src/Modules/Version/SupportedVersions.pqm',
    changelog: 'SafeguardSessions/CHANGELOG.md',
    form: '.github/ISSUE_TEMPLATE/release-request.yml',
  };
  for (const [key, relativePath] of Object.entries(destinations)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, updated[key], 'utf8');
  }

  fs.cpSync(path.join(trusted, 'Environment', 'Scripts'), path.join(root, 'Environment', 'Scripts'), {
    recursive: true,
    force: true,
  });
  VerifyFormDefaults(updated.form, plan.request);
}

function CopyTrustedScripts() {
  const root = process.env.SOURCE_DIRECTORY;
  const trusted = process.env.TRUSTED_DIRECTORY;
  Assert(root && trusted, 'Source and trusted directories must be set');
  fs.cpSync(path.join(trusted, 'Environment', 'Scripts'), path.join(root, 'Environment', 'Scripts'), {
    recursive: true,
    force: true,
  });
}

function FinalizePreparation() {
  const plan = ParsePlan();
  const root = process.env.SOURCE_DIRECTORY;
  Assert(root, 'SOURCE_DIRECTORY is not set');
  Assert(plan.runId === Number(process.env.GITHUB_RUN_ID), 'Release plan belongs to another workflow run');
  plan.runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  Assert(Number.isSafeInteger(plan.runAttempt) && plan.runAttempt > 0, 'Workflow run attempt is invalid');
  plan.release.branch = ReleaseBranch(plan.request, plan.issueNumber, plan.runId, plan.runAttempt);
  const sourceHead = Git(root, ['rev-parse', 'HEAD']).stdout.trim();
  Assert(sourceHead === plan.source.sha, 'Source checkout does not match the selected source commit');

  Git(root, ['switch', '-c', plan.release.branch]);
  Git(root, ['add', '--', ...RELEASE_PATHS]);
  const staged = Git(root, ['diff', '--cached', '--name-only']).stdout.split(/\r?\n/).filter(Boolean).sort();
  VerifyReleasePaths(staged, 'Staged release changes');
  const files = ReadReleaseFiles(root);
  const verified = VerifyReleaseFiles(files, plan.request);
  Assert(verified.valid, `Release changes are invalid: ${verified.errors.join('; ')}`);
  VerifyFormDefaults(files.form, plan.request);
  Git(root, [
    '-c', 'user.name=Copilot',
    '-c', 'user.email=223556219+Copilot@users.noreply.github.com',
    'commit', '-m', 'Safeguard Sessions: prepare release',
    '-m', `Scope: SafeguardSessions/ and .github/ISSUE_TEMPLATE/release-request.yml.\n\nPrepare ${plan.release.tag} from ${plan.source.branch}.\n\nReferences: #${plan.issueNumber}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
  ]);
  plan.release.commitSha = Git(root, ['rev-parse', 'HEAD']).stdout.trim();
  Assert(HEX_SHA.test(plan.release.commitSha), 'Prepared release commit SHA is invalid');
  VerifyCommitFiles(root, plan);
  const metadataPath = path.join(process.env.GITHUB_WORKSPACE, 'release-metadata.json');
  const bundlePath = path.join(process.env.GITHUB_WORKSPACE, 'release.bundle');
  fs.writeFileSync(metadataPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  Git(root, ['bundle', 'create', bundlePath, `refs/heads/${plan.release.branch}`]);
  WriteOutput('artifact_name', `sessions-release-preparation-${plan.runId}-${plan.runAttempt}`);
  WriteOutput('run_attempt', plan.runAttempt);
  WriteOutput('commit_sha', plan.release.commitSha);
  WriteSummary(`Preparation checks passed; generated commit \`${plan.release.commitSha}\` is ready for credentialed publication.`);
}

function VerifyBundleAndPlan(root, plan, bundlePath) {
  Assert(plan.schemaVersion === 1 && plan.workflowPath === WORKFLOW_PATH, 'Preparation artifact schema or workflow path is invalid');
  Assert(HEX_SHA.test(plan.automationSha) && Number.isSafeInteger(plan.runId) && plan.runId > 0
    && Number.isSafeInteger(plan.runAttempt) && plan.runAttempt > 0, 'Preparation artifact run identity is invalid');
  Assert(plan.repository === Repo(), 'Preparation artifact belongs to another repository');
  const requestValidation = ValidateRequest(plan.request);
  Assert(requestValidation.valid, `Preparation artifact request is invalid: ${requestValidation.errors.join('; ')}`);
  Assert(plan.source?.branch === plan.request.sourceBranch && HEX_SHA.test(plan.source.sha), 'Preparation artifact source ref is invalid');
  Assert(plan.target?.branch === plan.request.targetBranch && HEX_SHA.test(plan.target.sha), 'Preparation artifact target ref is invalid');
  ValidateBranchName(plan.source.branch);
  ValidateBranchName(plan.target.branch);
  Assert(plan.release?.tag === ReleaseTag(plan.request), 'Preparation artifact release tag is invalid');
  Assert(plan.release?.commitSha && HEX_SHA.test(plan.release.commitSha), 'Preparation artifact release commit is invalid');
  ValidateBranchName(plan.release.branch);
  Assert(plan.release.branch === ReleaseBranch(plan.request, plan.issueNumber, plan.runId, plan.runAttempt), 'Preparation artifact release branch is invalid');
  Git(root, ['bundle', 'verify', bundlePath]);
  const fetchRef = `refs/remotes/release-bundle/${plan.release.branch}`;
  Git(root, ['fetch', bundlePath, `refs/heads/${plan.release.branch}:${fetchRef}`]);
  Assert(Git(root, ['rev-parse', fetchRef]).stdout.trim() === plan.release.commitSha, 'Release bundle commit does not match metadata');
  Assert(Git(root, ['rev-parse', `${plan.release.commitSha}^`]).stdout.trim() === plan.source.sha, 'Release commit does not have the selected source commit as its parent');
  return VerifyCommitFiles(root, plan);
}

async function PublishPrepared() {
  const repository = Repo();
  const metadataPath = path.join(process.env.RELEASE_ARTIFACT_DIRECTORY, 'release-metadata.json');
  const bundlePath = path.join(process.env.RELEASE_ARTIFACT_DIRECTORY, 'release.bundle');
  const plan = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const preflightPlan = ParseEncodedPlan(process.env.PREFLIGHT_PLAN, 'PREFLIGHT_PLAN');
  ValidatePreparedArtifact(plan, preflightPlan, {
    repository,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.PREPARED_RUN_ATTEMPT),
    commitSha: process.env.PREPARED_COMMIT_SHA,
  });
  const root = process.env.SOURCE_DIRECTORY;
  Assert(root, 'SOURCE_DIRECTORY is not set');
  VerifyBundleAndPlan(root, plan, bundlePath);

  const apiRepo = EncodedRepository(repository);
  const permission = ApiGet(`repos/${apiRepo}/collaborators/${encodeURIComponent(plan.issueAuthor)}/permission`);
  AuthorizeIssueAuthor(permission.permission);
  const remoteRef = Git(root, ['ls-remote', '--heads', 'origin', plan.release.branch]).stdout.trim();
  if (remoteRef) {
    const [remoteSha] = remoteRef.split(/\s+/);
    Assert(remoteSha === plan.release.commitSha, 'Release branch already exists at a conflicting commit');
  } else {
    const adapter = GitHubAdapter(repository);
    const tag = await adapter.GetTag(plan.release.tag);
    Assert(!tag, `Release tag '${plan.release.tag}' appeared after preparation`);
    const release = ApiGet(`repos/${apiRepo}/releases/tags/${encodeURIComponent(plan.release.tag)}`, { notFound: true });
    Assert(!release, `Release '${plan.release.tag}' appeared after preparation`);
    const [duplicateRequest, conflictingBranch] = await Promise.all([
      adapter.FindDuplicateRequest(plan.release.tag, plan.issueNumber),
      adapter.FindConflictingBranch(
        `release/sessions/v${plan.request.connectorVersion}-sps${plan.request.spsVersion}`,
        `release/sessions/issue-${plan.issueNumber}-`,
      ),
    ]);
    Assert(!duplicateRequest && !conflictingBranch, `A duplicate release request appeared for '${plan.release.tag}'`);
    Git(root, ['push', 'origin', `${plan.release.commitSha}:refs/heads/${plan.release.branch}`]);
  }

  const listing = spawnSync('gh', [
    'pr', 'list', '--repo', repository, '--state', 'all',
    '--head', plan.release.branch, '--json', 'number,headRefOid,baseRefName,state,url',
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (listing.error) throw listing.error;
  Assert(listing.status === 0, `Could not inspect release PRs: ${(listing.stderr || '').trim()}`);
  const pullRequests = JSON.parse(listing.stdout);
  if (pullRequests.length > 0) {
    Assert(pullRequests.length === 1, 'Multiple PRs already exist for the prepared release branch');
    const existing = pullRequests[0];
    Assert(existing.headRefOid === plan.release.commitSha && existing.baseRefName === plan.target.branch, 'Existing PR conflicts with prepared release metadata');
    Assert(existing.state === 'OPEN', 'Prepared release PR has already been closed');
    WriteSummary(`Release PR already exists and matches the immutable preparation artifact: ${existing.url}`);
    return;
  }

  const title = `Safeguard Sessions ${plan.release.tag}`;
  const body = `Automated release preparation for #${plan.issueNumber}.\n\nSource: \`${plan.source.branch}\` at \`${plan.source.sha}\`  \nTarget: \`${plan.target.branch}\`  \nRelease tag: \`${plan.release.tag}\`\n\nMerge this PR to create a draft release.`;
  const created = spawnSync('gh', [
    'pr', 'create', '--repo', repository, '--base', plan.target.branch,
    '--head', plan.release.branch, '--title', title, '--body', body,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (created.error) throw created.error;
  Assert(created.status === 0, `Could not create release PR: ${(created.stderr || created.stdout || '').trim()}`);
  WriteSummary(`Created release PR: ${created.stdout.trim()}`);
}

function LocatePreparationArtifact() {
  const event = ReadEvent();
  const branch = event.pull_request?.head?.ref;
  const match = /^release\/sessions\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-sps(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-issue-(\d+)-run-(\d+)-attempt-(\d+)$/.exec(branch ?? '');
  Assert(match, 'Closed PR is not from a generated Safeguard Sessions release branch');
  const [, issueNumber, runId, runAttempt] = match;
  WriteOutput('issue_number', issueNumber);
  WriteOutput('run_id', runId);
  WriteOutput('run_attempt', runAttempt);
  WriteOutput('artifact_name', `sessions-release-preparation-${runId}-${runAttempt}`);
}

function VerifyMergedRelease() {
  const event = ReadEvent();
  const pullRequestEvent = event.pull_request;
  Assert(pullRequestEvent?.merged === true && pullRequestEvent.state === 'closed', 'Release PR was closed without merging');
  const metadataPath = process.env.PREPARATION_METADATA_PATH;
  const bundlePath = process.env.PREPARATION_BUNDLE_PATH;
  const plan = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const repository = Repo();
  Assert(plan.repository === repository, 'Preparation artifact repository does not match');
  Assert(plan.runId === Number(process.env.PREPARATION_RUN_ID) && plan.runAttempt === Number(process.env.PREPARATION_RUN_ATTEMPT), 'Preparation artifact run identity does not match PR branch');

  const apiRepo = EncodedRepository(repository);
  const run = ApiGet(`repos/${apiRepo}/actions/runs/${plan.runId}/attempts/${plan.runAttempt}`);
  const workflow = ApiGet(`repos/${apiRepo}/actions/workflows/prepare-release.yml`);
  const pr = ApiGet(`repos/${apiRepo}/pulls/${pullRequestEvent.number}`);
  ValidatePreparationMetadata(plan, {
    run,
    pullRequest: pr,
    repository,
    workflowId: workflow.id,
    mergedSha: pullRequestEvent.merge_commit_sha,
    defaultBranch: event.repository?.default_branch,
  });
  Assert(run.artifacts_url, 'Trusted preparation run has no artifacts endpoint');
  const artifacts = ApiGet(`repos/${apiRepo}/actions/runs/${plan.runId}/artifacts?per_page=100`).artifacts;
  const artifactName = `sessions-release-preparation-${plan.runId}-${plan.runAttempt}`;
  Assert(artifacts.some((artifact) => artifact.name === artifactName && artifact.expired === false), 'Immutable preparation artifact is missing or expired');

  const root = process.env.SOURCE_DIRECTORY;
  Assert(root, 'SOURCE_DIRECTORY is not set');
  ValidateSessionsConfig(root);
  const checkedOutSha = Git(root, ['rev-parse', 'HEAD']).stdout.trim();
  Assert(checkedOutSha === pr.merge_commit_sha, 'Source checkout does not match the exact merged commit');
  Git(root, ['bundle', 'verify', bundlePath]);
  const preparedRef = `refs/remotes/prepared/${plan.release.branch}`;
  Git(root, ['fetch', bundlePath, `refs/heads/${plan.release.branch}:${preparedRef}`]);
  Assert(Git(root, ['rev-parse', preparedRef]).stdout.trim() === plan.release.commitSha, 'Preparation bundle PR head does not match metadata');
  Assert(Git(root, ['rev-parse', `${plan.release.commitSha}^`]).stdout.trim() === plan.source.sha, 'Prepared PR head does not originate at the selected source commit');
  Git(root, ['merge-base', '--is-ancestor', plan.target.sha, pr.merge_commit_sha]);

  const releaseFiles = ReadReleaseFiles(root);
  const verified = VerifyReleaseFiles(releaseFiles, plan.request);
  Assert(verified.valid, `Merged release files do not match request: ${verified.errors.join('; ')}`);
  VerifyFormDefaults(releaseFiles.form, plan.request);
  return { plan, notes: verified.notes };
}

function CollectAssets(root) {
  return Object.entries(ASSET_PATHS).map(([name, relative]) => ({
    name,
    path: path.join(root, relative),
    data: fs.readFileSync(path.join(root, relative)),
  }));
}

function VerifyBuiltAssets() {
  const root = process.env.SOURCE_DIRECTORY;
  Assert(root, 'SOURCE_DIRECTORY is not set');
  const assets = CollectAssets(root);
  ValidateReleaseAssets(assets);
  const packageDir = path.join(process.env.GITHUB_WORKSPACE, 'release-assets');
  fs.mkdirSync(packageDir, { recursive: true });
  for (const asset of assets) fs.copyFileSync(asset.path, path.join(packageDir, asset.name));
  const event = ReadEvent();
  const metadataPath = process.env.PREPARATION_METADATA_PATH;
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const manifest = {
    repository: metadata.repository,
    runId: metadata.runId,
    runAttempt: metadata.runAttempt,
    issueNumber: metadata.issueNumber,
    request: metadata.request,
    source: metadata.source,
    target: metadata.target,
    release: metadata.release,
    mergedSha: event.pull_request.merge_commit_sha,
    assets: assets.map(({ name, data }) => ({ name, size: data.length, digest: AssetDigest(data) })),
  };
  fs.writeFileSync(path.join(packageDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  WriteOutput('artifact_name', `sessions-release-assets-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  WriteSummary(`Rebuilt and verified all four non-empty release assets at merged commit \`${manifest.mergedSha}\`.`);
}

function VerifyBuildPackage(packageDir, repository) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'release-manifest.json'), 'utf8'));
  Assert(manifest.repository === repository, 'Build artifact belongs to another repository');
  Assert(HEX_SHA.test(manifest.mergedSha), 'Build artifact merged commit is invalid');
  const assets = Object.keys(ASSET_PATHS).map((name) => {
    const data = fs.readFileSync(path.join(packageDir, name));
    Assert(data.length > 0, `Release asset '${name}' is empty`);
    const expected = manifest.assets.find((asset) => asset.name === name);
    Assert(expected && expected.size === data.length && expected.digest === AssetDigest(data), `Release asset '${name}' does not match the build manifest`);
    return { name, data };
  });
  ValidateReleaseAssets(assets);
  return { manifest, assets };
}

async function PublishDraft() {
  const repository = Repo();
  const packageDir = process.env.RELEASE_ASSET_DIRECTORY;
  const { manifest, assets } = VerifyBuildPackage(packageDir, repository);
  const event = ReadEvent();
  Assert(event.pull_request?.merged === true, 'Release PR was not merged');
  Assert(manifest.mergedSha === event.pull_request.merge_commit_sha, 'Build assets do not match the merged commit event');

  const apiRepo = EncodedRepository(repository);
  const pr = ApiGet(`repos/${apiRepo}/pulls/${event.pull_request.number}`);
  const run = ApiGet(`repos/${apiRepo}/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}`);
  const workflow = ApiGet(`repos/${apiRepo}/actions/workflows/prepare-release.yml`);
  const artifactName = `sessions-release-preparation-${manifest.runId}-${manifest.runAttempt}`;
  const artifacts = ApiGet(`repos/${apiRepo}/actions/runs/${manifest.runId}/artifacts?per_page=100`).artifacts;
  Assert(artifacts.some((artifact) => artifact.name === artifactName && artifact.expired === false), 'Preparation artifact is missing or expired');
  const metadataPath = process.env.PREPARATION_METADATA_PATH;
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  ValidatePreparationMetadata(metadata, {
    run,
    pullRequest: pr,
    repository,
    workflowId: workflow.id,
    mergedSha: event.pull_request.merge_commit_sha,
    defaultBranch: event.repository?.default_branch,
  });
  for (const key of ['repository', 'runId', 'runAttempt', 'issueNumber', 'request', 'source', 'target', 'release']) {
    Assert(JSON.stringify(manifest[key]) === JSON.stringify(metadata[key]), `Build manifest ${key} does not match immutable preparation metadata`);
  }

  const sourceRoot = process.env.SOURCE_DIRECTORY;
  Assert(sourceRoot && Git(sourceRoot, ['rev-parse', 'HEAD']).stdout.trim() === manifest.mergedSha, 'Publish checkout does not match exact merged commit');
  const bundlePath = process.env.PREPARATION_BUNDLE_PATH;
  Assert(bundlePath, 'PREPARATION_BUNDLE_PATH is not set');
  VerifyBundleAndPlan(sourceRoot, metadata, bundlePath);
  Git(sourceRoot, ['merge-base', '--is-ancestor', metadata.target.sha, manifest.mergedSha]);
  const mergedFiles = ReadReleaseFiles(sourceRoot);
  const verified = VerifyReleaseFiles(mergedFiles, metadata.request);
  Assert(verified.valid, `Merged release files failed publication verification: ${verified.errors.join('; ')}`);
  VerifyFormDefaults(mergedFiles.form, metadata.request);

  const result = await PublishDraftRelease({
    tag: metadata.release.tag,
    mergedSha: manifest.mergedSha,
    targetBranch: metadata.target.branch,
    notes: verified.notes,
    assets,
    github: MakePublisher(repository),
  });
  WriteSummary(`Created or safely resumed draft release [${result.tag}](https://github.com/${repository}/releases/tag/${encodeURIComponent(result.tag)}). The release remains a draft.`);
}

async function Main() {
  const command = process.argv[2];
  switch (command) {
    case 'preflight':
      await Preflight();
      return;
    case 'prepare-files':
      WriteReleaseFiles();
      return;
    case 'copy-trusted-scripts':
      CopyTrustedScripts();
      return;
    case 'finalize-preparation':
      FinalizePreparation();
      return;
    case 'publish-prepared':
      await PublishPrepared();
      return;
    case 'locate-preparation':
      LocatePreparationArtifact();
      return;
    case 'verify-merged':
      VerifyMergedRelease();
      return;
    case 'verify-assets':
      VerifyBuiltAssets();
      return;
    case 'publish-draft':
      await PublishDraft();
      return;
    default:
      throw new Error(`Unknown release automation command '${String(command)}'`);
  }
}

module.exports = {
  AuthorizeIssueAuthor,
  CreatePreparationPlan,
  ValidateBranchName,
  ValidatePreparationMetadata,
  ValidatePreparedArtifact,
  ValidateReleaseAssets,
  PublishDraftRelease,
  VerifyCommitFiles,
};

if (require.main === module) {
  Main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
