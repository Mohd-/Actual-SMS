import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Preserve reconciliation and the original first write for older frozen
// import plans from the merchant-approval release.
const entry = createRequire(import.meta.url).resolve('@actual-app/api');
const original = readFileSync(entry, 'utf8');
const marker = 'exports.actualSmsPendingAssignmentImport = true;';
const loop = 'for (const { payee_name, trans: originalTrans, subtransactions } of normalized) {';
const originalRule = 'const trans = await runRules$1(originalTrans, accountsMap);';
const anchor = 'const transactionsStep1 = [];\n\t' + loop + '\n\t\t' + originalRule;
const replacement = [
  'const transactionsStep1 = [];',
  '\t' + loop,
  '\t\tconst { preservePendingAssignment, ...transaction } = originalTrans;',
  '\t\tconst trans = preservePendingAssignment === true ? transaction : await runRules$1(transaction, accountsMap);',
].join('\n');

if (!original.includes(marker)) {
  if (original.split(anchor).length !== 2)
    throw new Error(
      'Actual SDK reconciliation changed. Review pending-assignment imports for this SDK version.',
    );
  writeFileSync(entry, original.replace(anchor, replacement) + '\n' + marker + '\n');
}
