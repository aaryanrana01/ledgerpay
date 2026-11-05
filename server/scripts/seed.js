/**
 * Populates a realistic demo dataset: five users, funded wallets, and ~60 days
 * of transfers so the dashboard and activity feed have something to show.
 *
 *   npm run seed
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/db/mongoose.js';
import { ensureSystemAccounts } from '../src/services/ledger.service.js';
import { topUp, transfer } from '../src/services/wallet.service.js';
import { register } from '../src/services/auth.service.js';
import { User } from '../src/models/index.js';
import { randomId } from '../src/utils/hash.js';
import { minorToDecimalString, parseAmountToMinor } from '../src/utils/money.js';

const PASSWORD = 'DemoPassw0rd';

const PEOPLE = [
  { fullName: 'Arjun Mehta', walletTag: 'arjun', email: 'arjun@ledgerpay.dev', fund: '18500.00' },
  { fullName: 'Priya Nair', walletTag: 'priya', email: 'priya@ledgerpay.dev', fund: '9200.00' },
  { fullName: 'Rohan Das', walletTag: 'rohan', email: 'rohan@ledgerpay.dev', fund: '4300.00' },
  { fullName: 'Sara Iyer', walletTag: 'sara', email: 'sara@ledgerpay.dev', fund: '15750.00' },
  { fullName: 'Admin', walletTag: 'admin', email: 'admin@ledgerpay.dev', fund: '1000.00', role: 'ADMIN' },
];

const NOTES = [
  'Dinner split', 'Rent share', 'Cab fare', 'Concert tickets', 'Groceries',
  'Birthday gift', 'Coffee', 'Flatmate settle-up', 'Movie night', 'Book order',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randomAmount = () => (Math.floor(Math.random() * 240) + 10) * 100 + Math.floor(Math.random() * 100);

async function run() {
  await connectDatabase();
  await ensureSystemAccounts();

  // Start from a completely clean slate. Dropping the database also drops the
  // indexes, so we ask Mongoose to rebuild them before inserting anything -
  // otherwise the unique constraints on email and walletTag would not exist
  // yet and duplicate data could slip in.
  console.log('Clearing existing data...');
  await mongoose.connection.dropDatabase();

  for (const model of Object.values(mongoose.models)) {
    // eslint-disable-next-line no-await-in-loop
    await model.syncIndexes();
  }

  // The system accounts were dropped along with everything else, so recreate
  // them before any money moves.
  await ensureSystemAccounts();

  const created = [];
  for (const person of PEOPLE) {
    // eslint-disable-next-line no-await-in-loop
    const { user } = await register(
      { fullName: person.fullName, email: person.email, walletTag: person.walletTag, password: PASSWORD },
      { ip: '127.0.0.1', userAgent: 'seed-script' }
    );
    if (person.role === 'ADMIN') {
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne({ _id: user._id }, { role: 'ADMIN' });
    }
    // eslint-disable-next-line no-await-in-loop
    await topUp({ userId: user._id, amountMinor: parseAmountToMinor(person.fund), idempotencyKey: randomId(12) });
    created.push({ ...person, id: user._id });
    console.log(`  created @${person.walletTag} funded with ${person.fund}`);
  }

  console.log('Posting demo transfers…');
  const spenders = created.filter((p) => p.role !== 'ADMIN');
  let posted = 0;

  for (let i = 0; i < 70; i += 1) {
    const sender = pick(spenders);
    const recipient = pick(spenders.filter((p) => p.walletTag !== sender.walletTag));
    try {
      // eslint-disable-next-line no-await-in-loop
      await transfer({
        senderUserId: sender.id,
        recipientWalletTag: recipient.walletTag,
        amountMinor: randomAmount(),
        note: pick(NOTES),
        idempotencyKey: randomId(12),
      });
      posted += 1;
    } catch (error) {
      if (error.code !== 'INSUFFICIENT_FUNDS' && error.code !== 'DAILY_LIMIT_EXCEEDED') throw error;
    }
  }

  console.log(`\nSeeded ${created.length} users and ${posted} transfers.`);
  console.log('\nSign in with any of these:');
  for (const person of created) {
    console.log(`  ${person.email.padEnd(26)} ${PASSWORD}   @${person.walletTag}`);
  }
  console.log(`\nSystem settlement balance: ${minorToDecimalString(0)} (top-ups are funded from it, so it runs negative)`);

  await disconnectDatabase();
}

run().catch(async (error) => {
  console.error('Seed failed:', error);
  await disconnectDatabase();
  process.exit(1);
});
