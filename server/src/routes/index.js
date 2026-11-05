import { Router } from 'express';
import authRoutes from './auth.routes.js';
import walletRoutes from './wallet.routes.js';
import adminRoutes from './admin.routes.js';
import paymentRoutes from './payments.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/wallet', walletRoutes);
router.use('/payments', paymentRoutes);
router.use('/admin', adminRoutes);

export default router;
