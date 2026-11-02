'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseRequest, validateRequest, updateReleaseFiles, verifyReleaseFiles } = require('./Request.cjs');

const issueBody = [
  '### Release request marker',
  'safeguard-sessions-release-request-v1',
  '',
  '### Connector version',
  '2.0.6',
  '',
  '### SPS version',
  '9.2.0',
  '',
  '### Supported versions',
  '7.3,7.4,7.5,8.0,8.1,8.2,9.0,9.1,9.2',
  '',
  '### Source branch',
  'main',
  '',
  '### Target branch',
  'main',
  '',
  '### Changelog body',
  '',
  '### Compatible SPS Versions',
  '',
  '* Feature: 7.3.0 - 9.2.0',
  '* LTS: 8.0.0 - 9.0.0',
  '',
  '> Quote with Unicode: café 🛡️',
  '',
].join('\n');

const request = parseRequest(issueBody);
const sourceFixtures = {
  connector: '\uFEFF[Version = "2.0.5"]\nsection SafeguardSessions;\n',
  supportedVersions: [
    'let',
    '    SupportedVersions.LatestVersion = "9.1", SupportedVersions.Versions = {"7.3", "7.4", "7.5", "8.0", "8.1", "8.2", "9.0", "9.1"}',
    'in',
    '    [Versions = SupportedVersions.Versions, LatestVersion = SupportedVersions.LatestVersion]',
    '',
  ].join('\n'),
  changelog: [
    '# Changelog',
    '',
    '## [v2.0.5+sps9.1.0] - 2026-10-28',
    '',
    '### Compatible SPS Versions',
    '',
    '* Feature: 7.3.0 - 9.1.0',
    '* LTS: 8.0.0 - 9.0.0',
    '',
    '## [v2.0.4+sps9.0.0] - 2026-07-20',
    '',
  ].join('\n'),
};

test('parseRequest preserves nested Markdown, blank lines, quotes, and Unicode', () => {
  const request = parseRequest(issueBody);

  assert.equal(request.connectorVersion, '2.0.6');
  assert.deepEqual(request.supportedVersions, [
    '7.3', '7.4', '7.5', '8.0', '8.1', '8.2', '9.0', '9.1', '9.2',
  ]);
  assert.equal(request.changelogBody, [
    '### Compatible SPS Versions',
    '',
    '* Feature: 7.3.0 - 9.2.0',
    '* LTS: 8.0.0 - 9.0.0',
    '',
    '> Quote with Unicode: café 🛡️',
  ].join('\n'));
});

test('parseRequest rejects missing, duplicate, or incorrectly marked fields', () => {
  assert.throws(() => parseRequest(issueBody.replace('### SPS version\n9.2.0\n\n', '')), /Missing issue fields/);
  assert.throws(
    () => parseRequest(issueBody.replace('### Target branch\nmain\n\n', '### SPS version\n9.2.0\n\n### Target branch\nmain\n\n')),
    /Ambiguous issue fields/,
  );
  assert.throws(
    () => parseRequest(issueBody.replace('safeguard-sessions-release-request-v1', 'release-request')),
    /Invalid release request marker/,
  );
});

test('issue form submits its required static marker and keeps branch defaults on main', () => {
  const form = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', 'release-request.yml'),
    'utf8',
  );
  assert.match(form, /id: release_request_marker[\s\S]*?value: "safeguard-sessions-release-request-v1"[\s\S]*?required: true/);
  assert.match(form, /id: source_branch[\s\S]*?value: "main"/);
  assert.match(form, /id: target_branch[\s\S]*?value: "main"/);
});

test('validateRequest requires strict versions and unique, aligned supported versions', () => {
  assert.deepEqual(validateRequest(request), { valid: true, errors: [] });

  assert.ok(validateRequest({ ...request, connectorVersion: '2.06' }).errors.includes('Connector version must be x.y.z'));
  assert.ok(validateRequest({ ...request, supportedVersions: ['7.3', '7.3', '9.2'] }).errors.includes('Supported versions must be unique'));
  assert.ok(validateRequest({ ...request, supportedVersions: ['7.3', '9.1'] }).errors.includes('Supported versions must end with the SPS major/minor version (9.2)'));
});

test('updateReleaseFiles changes only the release values and verifies exact release notes', () => {
  const formPath = path.join(__dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', 'release-request.yml');
  const files = updateReleaseFiles({
    ...sourceFixtures,
    form: fs.readFileSync(formPath, 'utf8'),
  }, request, '2026-11-02');

  assert.match(files.connector, /^\uFEFF\[Version = "2\.0\.6"\]/);
  assert.match(files.supportedVersions, /LatestVersion = "9\.2", SupportedVersions\.Versions = \{"7\.3", "7\.4", "7\.5", "8\.0", "8\.1", "8\.2", "9\.0", "9\.1", "9\.2"\}/);
  assert.match(files.changelog, /^# Changelog\n\n## \[v2\.0\.6\+sps9\.2\.0\] - 2026-11-02\n\n### Compatible SPS Versions/m);
  assert.match(files.form, /labels:\r?\n  - release-request/);
  assert.match(files.form, /id: source_branch[\s\S]*?value: "main"/);
  assert.match(files.form, /id: target_branch[\s\S]*?value: "main"/);
  assert.match(files.form, /id: connector_version[\s\S]*?value: "2\.0\.6"/);

  const verified = verifyReleaseFiles(files, request);
  assert.deepEqual(verified, {
    valid: true,
    errors: [],
    notes: request.changelogBody,
  });
  assert.equal(sourceFixtures.connector, '\uFEFF[Version = "2.0.5"]\nsection SafeguardSessions;\n');
});

test('release updates accept the checked-in source shapes without changing source files', () => {
  const root = path.join(__dirname, '..', '..');
  const files = {
    connector: fs.readFileSync(path.join(root, 'SafeguardSessions', 'Src', 'SafeguardSessions.pq'), 'utf8'),
    supportedVersions: fs.readFileSync(path.join(root, 'SafeguardSessions', 'Src', 'Modules', 'Version', 'SupportedVersions.pqm'), 'utf8'),
    changelog: fs.readFileSync(path.join(root, 'SafeguardSessions', 'CHANGELOG.md'), 'utf8'),
    form: fs.readFileSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'release-request.yml'), 'utf8'),
  };
  const updated = updateReleaseFiles(files, request, '2026-11-02');

  assert.equal(verifyReleaseFiles(updated, request).valid, true);
  assert.match(files.connector, /^\uFEFF\[Version = "2\.0\.5"\]/);
  assert.match(files.supportedVersions, /LatestVersion = "9\.1"/);
  assert.match(files.changelog, /\[v2\.0\.5\+sps9\.1\.0\]/);
});

test('release verification rejects mismatches and duplicate changelog releases', () => {
  const files = updateReleaseFiles({
    ...sourceFixtures,
    form: fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', 'release-request.yml'), 'utf8'),
  }, request, '2026-11-02');

  const duplicate = files.changelog.replace(
    '## [v2.0.6+sps9.2.0] - 2026-11-02',
    '## [v2.0.6+sps9.2.0] - 2026-11-02\n\n## [v2.0.6+sps9.2.0] - 2026-11-03',
  );
  assert.ok(verifyReleaseFiles({ ...files, changelog: duplicate }, request).errors.includes('Changelog contains a duplicate release entry'));
  assert.ok(verifyReleaseFiles({ ...files, connector: '[Version = "2.0.5"]\n' }, request).errors.includes('Connector version does not match the request'));
  assert.throws(
    () => updateReleaseFiles({
      ...sourceFixtures,
      changelog: sourceFixtures.changelog.replace(
        '## [v2.0.5+sps9.1.0] - 2026-10-28',
        '## [v2.0.6+sps9.2.0] - 2026-10-28',
      ),
      form: fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', 'release-request.yml'), 'utf8'),
    }, request, '2026-11-02'),
    /Changelog already contains this release/,
  );
});
