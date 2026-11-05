import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AuditLog, Account, User } from '../models/index.js';
import { reconcileSystem } from '../services/ledger.service.js';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

/**
 * The books must balance: every debit in the system has a matching credit, so
 * the grand total is zero and no cached balance has drifted from its ledger.
 * Run this on a schedule in production and page someone if `balanced` is false.
 */
router.get('/reconciliation', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await reconcileSystem() });
  } catch (error) {
    next(error);
  }
});

router.get('/accounts', async (_req, res, next) => {
  try {
    const accounts = await Account.find().populate('userId', 'email walletTag fullName').lean();
    res.json({
      ok: true,
      data: accounts.map((account) => ({
        id: String(account._id),
        kind: account.kind,
        owner: account.userId ? account.userId.walletTag : account.systemKey,
        balanceMinor: account.balanceMinor,
        entryCount: account.entryCount,
        status: account.status,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/users/:id/status', async (req, res, next) => {
  try {
    const status = req.body?.status === 'FROZEN' ? 'FROZEN' : 'ACTIVE';
    const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true });
    await Account.updateOne({ userId: req.params.id, kind: 'USER' }, { status });
    res.json({ ok: true, data: { user: user?.toPublic() ?? null } });
  } catch (error) {
    next(error);
  }
});

router.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ ok: true, data: { logs } });
  } catch (error) {
    next(error);
  }
});

export default router;
