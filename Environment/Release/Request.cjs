'use strict';

const FIELD_HEADINGS = Object.freeze({
  'Release request marker': 'marker',
  'Connector version': 'connectorVersion',
  'SPS version': 'spsVersion',
  'Supported versions': 'supportedVersions',
  'Source branch': 'sourceBranch',
  'Target branch': 'targetBranch',
  'Changelog body': 'changelogBody',
});

const REQUEST_MARKER = 'safeguard-sessions-release-request-v1';
const VERSION_TRIPLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_PAIR = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function ParseRequest(issueBody) {
  if (typeof issueBody !== 'string') {
    throw new TypeError('Issue body must be a string');
  }

  const lines = issueBody.split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^### (.+?)\s*$/.exec(lines[index]);
    if (match && Object.hasOwn(FIELD_HEADINGS, match[1])) {
      headings.push({ label: match[1], index });
      if (match[1] === 'Changelog body') break;
    }
  }

  const occurrences = new Map();
  for (const heading of headings) {
    occurrences.set(heading.label, (occurrences.get(heading.label) ?? 0) + 1);
  }
  const duplicates = [...occurrences].filter(([, count]) => count > 1).map(([label]) => label);
  if (duplicates.length > 0) {
    throw new Error(`Ambiguous issue fields: ${duplicates.join(', ')}`);
  }

  const missing = Object.keys(FIELD_HEADINGS).filter((label) => !occurrences.has(label));
  if (missing.length > 0) {
    throw new Error(`Missing issue fields: ${missing.join(', ')}`);
  }
  if (headings.at(-1).label !== 'Changelog body') {
    throw new Error('Changelog body must be the final issue field');
  }

  const request = {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const end = headings[index + 1]?.index ?? lines.length;
    const valueLines = lines.slice(heading.index + 1, end);
    const key = FIELD_HEADINGS[heading.label];
    if (key === 'changelogBody') {
      if (valueLines[0] === '') valueLines.shift();
      if (valueLines.at(-1) === '') valueLines.pop();
      request[key] = valueLines.join('\n');
    } else if (key === 'supportedVersions') {
      request[key] = valueLines.join('\n').split(',').map((version) => version.trim());
    } else {
      request[key] = valueLines.join('\n').trim();
    }
  }

  if (request.marker !== REQUEST_MARKER) {
    throw new Error('Invalid release request marker');
  }
  delete request.marker;
  return request;
}

function ValidateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { valid: false, errors: ['Request must be an object'] };
  }

  for (const [key, label] of [
    ['connectorVersion', 'Connector version'],
    ['spsVersion', 'SPS version'],
  ]) {
    if (typeof request[key] !== 'string' || !VERSION_TRIPLE.test(request[key])) {
      errors.push(`${label} must be x.y.z`);
    }
  }

  let supportedVersions;
  if (Array.isArray(request.supportedVersions)) {
    supportedVersions = request.supportedVersions;
  } else if (typeof request.supportedVersions === 'string') {
    supportedVersions = request.supportedVersions.split(',').map((version) => version.trim());
  } else {
    supportedVersions = [];
  }

  if (supportedVersions.length === 0 || supportedVersions.some((version) => typeof version !== 'string' || !VERSION_PAIR.test(version))) {
    errors.push('Supported versions must be a comma-separated list of x.y versions');
  }
  if (new Set(supportedVersions).size !== supportedVersions.length) {
    errors.push('Supported versions must be unique');
  }
  if (typeof request.spsVersion === 'string' && VERSION_TRIPLE.test(request.spsVersion)) {
    const [, major, minor] = request.spsVersion.match(VERSION_TRIPLE);
    const latestVersion = `${major}.${minor}`;
    if (supportedVersions.at(-1) !== latestVersion) {
      errors.push(`Supported versions must end with the SPS major/minor version (${latestVersion})`);
    }
  }

  for (const [key, label] of [
    ['sourceBranch', 'Source branch'],
    ['targetBranch', 'Target branch'],
  ]) {
    if (typeof request[key] !== 'string' || request[key].trim() === '') {
      errors.push(`${label} is required`);
    }
  }
  if (typeof request.changelogBody !== 'string' || request.changelogBody.trim() === '') {
    errors.push('Changelog body is required');
  }

  return { valid: errors.length === 0, errors };
}

function RequireValidRequest(request) {
  const validation = ValidateRequest(request);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }
}

function GetVersionDeclaration(connector) {
  if (typeof connector !== 'string') return null;
  const declarations = [...connector.matchAll(/^\uFEFF?\[Version = "([^"]+)"\]/gm)];
  return declarations.length === 1 ? declarations[0] : null;
}

function GetSupportedDeclaration(source) {
  if (typeof source !== 'string') return null;
  const declarations = [...source.matchAll(/(SupportedVersions\.LatestVersion\s*=\s*")([^"]+)(",\s*SupportedVersions\.Versions\s*=\s*\{)([^}]*)(\})/g)];
  if (declarations.length !== 1) return null;

  const [, , latestVersion, , listText] = declarations[0];
  const entries = listText.split(',').map((entry) => {
    const match = /^\s*"((?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"\s*$/.exec(entry);
    return match?.[1] ?? null;
  });
  if (entries.length === 0 || entries.some((entry) => entry === null) || !VERSION_PAIR.test(latestVersion)) {
    return null;
  }
  return { latestVersion, versions: entries, match: declarations[0] };
}

function ReplaceFormValue(form, fieldId, value) {
  if (typeof form !== 'string') throw new TypeError('Issue form must be a string');
  const newline = form.includes('\r\n') ? '\r\n' : '\n';
  const lines = form.split(/\r?\n/);
  const idLine = `id: ${fieldId}`;
  const matches = [];
  lines.forEach((line, index) => {
    if (line.trim() === idLine) matches.push(index);
  });
  if (matches.length !== 1) {
    throw new Error(`Issue form must contain exactly one ${fieldId} field`);
  }

  const start = matches[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  - type:/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const valueLines = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*value:/.test(lines[index])) valueLines.push(index);
  }
  if (valueLines.length !== 1) {
    throw new Error(`Issue form must contain exactly one value for ${fieldId}`);
  }
  const lineIndex = valueLines[0];
  const indent = /^\s*/.exec(lines[lineIndex])[0];
  lines[lineIndex] = `${indent}value: ${JSON.stringify(value)}`;
  return lines.join(newline);
}

function UpdateFormDefaults(form, request) {
  const replacements = [
    ['connector_version', request.connectorVersion],
    ['sps_version', request.spsVersion],
    ['supported_versions', request.supportedVersions.join(',')],
    ['changelog_body', request.changelogBody],
  ];
  return replacements.reduce(
    (updatedForm, [fieldId, value]) => ReplaceFormValue(updatedForm, fieldId, value),
    form,
  );
}

function AssertUniqueReleaseEntry(changelog, connectorVersion, spsVersion) {
  const expectedHeading = new RegExp(
    `^## \\[v${EscapeRegExp(connectorVersion)}\\+sps${EscapeRegExp(spsVersion)}\\] - \\d{4}-\\d{2}-\\d{2}[ \\t]*$`,
    'gm',
  );
  return [...changelog.matchAll(expectedHeading)];
}

function EscapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

function PrependChangelogEntry(changelog, request, date) {
  if (typeof changelog !== 'string') throw new TypeError('Changelog must be a string');
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const header = /^# Changelog[ \t]*$/gm;
  const headers = [...changelog.matchAll(header)];
  if (headers.length !== 1) throw new Error('Changelog must contain exactly one # Changelog heading');
  if (AssertUniqueReleaseEntry(changelog, request.connectorVersion, request.spsVersion).length > 0) {
    throw new Error('Changelog already contains this release');
  }

  const heading = `## [v${request.connectorVersion}+sps${request.spsVersion}] - ${date}`;
  const index = headers[0].index + headers[0][0].length;
  const remaining = changelog.slice(index).replace(/^(?:\r?\n){2}/, '');
  return `${changelog.slice(0, index)}${eol}${eol}${heading}${eol}${eol}${request.changelogBody}${eol}${eol}${remaining}`;
}

function UpdateReleaseFiles(files, request, releaseDate) {
  RequireValidRequest(request);
  if (!files || typeof files !== 'object') throw new TypeError('Release files must be an object');
  if (!ValidDate(releaseDate)) throw new Error('Release date must be a real YYYY-MM-DD date');

  const connectorDeclaration = GetVersionDeclaration(files.connector);
  if (!connectorDeclaration) throw new Error('Connector source must contain exactly one version declaration');
  const connector = files.connector.replace(
    connectorDeclaration[0],
    connectorDeclaration[0].replace(connectorDeclaration[1], request.connectorVersion),
  );

  const supportedDeclaration = GetSupportedDeclaration(files.supportedVersions);
  if (!supportedDeclaration) throw new Error('Supported versions source has an unsupported structure');
  const latestVersion = request.spsVersion.split('.').slice(0, 2).join('.');
  const listText = request.supportedVersions.map((version) => `"${version}"`).join(', ');
  const supportedVersions = files.supportedVersions.replace(
    supportedDeclaration.match[0],
    `${supportedDeclaration.match[1]}${latestVersion}${supportedDeclaration.match[3]}${listText}${supportedDeclaration.match[5]}`,
  );

  return {
    ...files,
    connector,
    supportedVersions,
    changelog: PrependChangelogEntry(files.changelog, request, releaseDate),
    form: UpdateFormDefaults(files.form, request),
  };
}

function GetReleaseNotes(changelog, headingMatches) {
  if (headingMatches.length !== 1) return null;
  const heading = headingMatches[0];
  const start = heading.index + heading[0].length;
  const nextHeading = /^## \[v.+\] - \d{4}-\d{2}-\d{2}[ \t]*$/gm;
  nextHeading.lastIndex = start;
  const next = nextHeading.exec(changelog);
  const end = next ? next.index : changelog.length;
  let notes = changelog.slice(start, end);
  notes = notes.replace(/^(?:\r?\n){2}/, '');
  notes = notes.replace(/(?:\r?\n){2}$/, '');
  return notes;
}

function VerifyReleaseFiles(files, request) {
  const validation = ValidateRequest(request);
  if (!validation.valid) return { valid: false, errors: validation.errors, notes: null };
  const errors = [];
  const connectorDeclaration = GetVersionDeclaration(files?.connector);
  if (!connectorDeclaration || connectorDeclaration[1] !== request.connectorVersion) {
    errors.push('Connector version does not match the request');
  }

  const supportedDeclaration = GetSupportedDeclaration(files?.supportedVersions);
  const expectedLatest = request.spsVersion.split('.').slice(0, 2).join('.');
  if (!supportedDeclaration || supportedDeclaration.latestVersion !== expectedLatest) {
    errors.push('Latest SPS version does not match the request');
  }
  if (!supportedDeclaration || JSON.stringify(supportedDeclaration.versions) !== JSON.stringify(request.supportedVersions)) {
    errors.push('Supported versions do not match the request');
  }

  const changelog = files?.changelog;
  const headingMatches = typeof changelog === 'string'
    ? AssertUniqueReleaseEntry(changelog, request.connectorVersion, request.spsVersion)
    : [];
  if (headingMatches.length === 0) {
    errors.push('Changelog release entry does not match the request');
  } else if (headingMatches.length > 1) {
    errors.push('Changelog contains a duplicate release entry');
  }
  if (typeof changelog === 'string' && headingMatches.length === 1) {
    const firstRelease = /^## \[v.+\] - \d{4}-\d{2}-\d{2}[ \t]*$/m.exec(changelog);
    if (firstRelease && firstRelease.index !== headingMatches[0].index) {
      errors.push('Changelog release entry is not the latest entry');
    }
  }
  const notes = typeof changelog === 'string'
    ? GetReleaseNotes(changelog, headingMatches)
    : null;
  if (notes !== null && notes !== request.changelogBody) {
    errors.push('Changelog body does not match the request');
  }

  return { valid: errors.length === 0, errors, notes };
}

module.exports = {
  ParseRequest,
  ValidateRequest,
  UpdateReleaseFiles,
  VerifyReleaseFiles,
};
