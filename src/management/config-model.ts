import { Document, isSeq, parseDocument, type YAMLSeq } from 'yaml';
import type { ConfigPatch, ConfigFile, ParsingFileView } from './contracts.js';
import type { ConfigFiles } from '../runtime-config.js';
import { ConfigurationError } from '../runtime-config.js';
import type { AccountsFileView, BanksFileView } from './contracts.js';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const accountMatchFields = new Set([
  'bank',
  'accountSuffixes',
  'transferIdentifiers',
  'billPaymentIdentifiers',
  'transactionKinds',
  'hasBalance',
]);
const bankFields = new Set(['name', 'senders', 'messageAliases', 'disposition', 'templates']);

function documentFor(text: string, file: ConfigFile) {
  const doc = parseDocument(text);
  if (doc.errors.length)
    throw new ConfigurationError(`${file} configuration: ${doc.errors[0]!.message}`);
  return doc;
}

function validPath(path: (string | number)[]) {
  return (
    path.length > 0 &&
    path.length <= 12 &&
    path.every(
      part =>
        (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0) ||
        (typeof part === 'string' &&
          part.length > 0 &&
          part.length <= 200 &&
          !forbiddenKeys.has(part)),
    )
  );
}

function index(path: (string | number)[], position: number) {
  const value = path[position];
  return typeof value === 'number' ? value : undefined;
}

function accountPath(path: (string | number)[]) {
  if (path.length === 1)
    return (
      path[0] === 'accounts' || path[0] === 'bankFeesCategory' || path[0] === 'eligibleCategories'
    );
  if (path[0] !== 'accounts' || index(path, 1) === undefined) return false;
  if (path.length === 2) return true;
  if (path.length === 3) return path[2] === 'actualName' || path[2] === 'match';
  return (
    path.length === 4 &&
    path[2] === 'match' &&
    typeof path[3] === 'string' &&
    accountMatchFields.has(path[3])
  );
}

function bankPath(path: (string | number)[]) {
  if (path[0] !== 'banks') return false;
  if (path.length === 1) return true;
  if (index(path, 1) === undefined) return false;
  if (path.length === 2) return true;
  return path.length === 3 && typeof path[2] === 'string' && bankFields.has(path[2]);
}

function parsingPath(path: (string | number)[]) {
  return (
    (path[0] === 'shared' || path[0] === 'templates') &&
    path.slice(1).every(part => typeof part === 'string' || typeof part === 'number')
  );
}

function assertAllowed(patch: ConfigPatch) {
  if (!validPath(patch.path))
    throw new ConfigurationError('Configuration change has an invalid path');
  const allowed =
    patch.file === 'accounts'
      ? accountPath(patch.path)
      : patch.file === 'banks'
        ? bankPath(patch.path)
        : parsingPath(patch.path);
  if (!allowed) throw new ConfigurationError('Configuration change is not allowed');
  if (patch.op === 'move' && (patch.from === undefined || patch.to === undefined))
    throw new ConfigurationError('Configuration move needs from and to positions');
  if ((patch.op === 'set' || patch.op === 'insert') && patch.value === undefined)
    throw new ConfigurationError('Configuration change is missing a value');
}

function move(seq: YAMLSeq, from: number, to: number) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= seq.items.length ||
    to >= seq.items.length
  )
    throw new ConfigurationError('Configuration move position is out of range');
  const [item] = seq.items.splice(from, 1);
  seq.items.splice(to, 0, item);
}

export function modelFromFiles(files: ConfigFiles) {
  return {
    accounts: (documentFor(files.accounts, 'accounts').toJS() ?? {}) as AccountsFileView,
    banks: (documentFor(files.banks, 'banks').toJS() ?? {}) as BanksFileView,
    parsing: (documentFor(files.parsing, 'parsing').toJS() ?? {}) as ParsingFileView,
  };
}

export function applyConfigPatches(files: ConfigFiles, file: ConfigFile, patches: ConfigPatch[]) {
  const doc = documentFor(files[file], file);
  for (const patch of patches) {
    if (patch.file !== file)
      throw new ConfigurationError('Configuration change targets a different file');
    assertAllowed(patch);
    if (patch.op === 'set') doc.setIn(patch.path, patch.value);
    else if (patch.op === 'delete') doc.deleteIn(patch.path);
    else if (patch.op === 'insert') {
      const container = doc.getIn(patch.path, true);
      if (isSeq(container)) container.add(doc.createNode(patch.value));
      else if (
        file === 'parsing' &&
        patch.path.length === 1 &&
        patch.path[0] === 'templates' &&
        !doc.hasIn(patch.path)
      )
        doc.setIn(patch.path, doc.createNode([patch.value]));
      else throw new ConfigurationError('Configuration insert target is not a list');
    } else {
      const container = doc.getIn(patch.path, true);
      if (!isSeq(container))
        throw new ConfigurationError('Configuration move target is not a list');
      move(container, patch.from!, patch.to!);
    }
  }
  const text = doc.toString();
  if (!(doc instanceof Document) || doc.errors.length)
    throw new ConfigurationError(`${file} configuration could not be written`);
  return text;
}
