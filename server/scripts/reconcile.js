/**
 * Standalone reconciliation. In production this runs on a cron and pages
 * someone when it fails.
 *
 *   npm run reconcile
 *
 * Exits non-zero when the books do not balance, so CI or a scheduler can
 * treat it as a failing check.
 */
import { connectDatabase, disconnectDatabase } from '../src/db/mongoose.js';
import { reconcileSystem } from '../src/services/ledger.service.js';
import { Account } from '../src/models/index.js';
import { minorToDecimalString } from '../src/utils/money.js';

async function run() {
  await connectDatabase();

  const result = await reconcileSystem();
  const accounts = await Account.find().lean();
  const userTotal = accounts.filter((a) => a.kind === 'USER').reduce((s, a) => s + a.balanceMinor, 0);
  const systemTotal = accounts.filter((a) => a.kind !== 'USER').reduce((s, a) => s + a.balanceMinor, 0);

  console.log('\n  Ledger reconciliation');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  total debits        ${minorToDecimalString(result.totalDebitsMinor).padStart(16)}`);
  console.log(`  total credits       ${minorToDecimalString(result.totalCreditsMinor).padStart(16)}`);
  console.log(`  user balances       ${minorToDecimalString(userTotal).padStart(16)}`);
  console.log(`  system balances     ${minorToDecimalString(systemTotal).padStart(16)}`);
  console.log(`  sum of all accounts ${minorToDecimalString(userTotal + systemTotal).padStart(16)}  (must be 0.00)`);
  console.log(`  drifting accounts   ${String(result.driftingAccounts.length).padStart(16)}`);
  console.log('  ─────────────────────────────────────────────');
  console.log(`  ${result.balanced ? 'BALANCED' : 'OUT OF BALANCE'}\n`);

  if (result.driftingAccounts.length) {
    console.table(result.driftingAccounts.map((a) => ({
      account: String(a.accountId),
      cached: minorToDecimalString(a.cachedBalance),
      ledger: minorToDecimalString(a.ledgerBalance),
      drift: minorToDecimalString(a.drift),
    })));
  }

  await disconnectDatabase();
  process.exit(result.balanced && userTotal + systemTotal === 0 ? 0 : 1);
}

run().catch(async (error) => {
  console.error('Reconciliation failed:', error);
  await disconnectDatabase();
  process.exit(1);
});
