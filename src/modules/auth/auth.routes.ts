import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { loginRateLimiter } from '../../common/middleware/rateLimiter';
import { validateBody } from '../../common/middleware/validate';
import { login, logout, me } from './auth.controller';
import { loginSchema } from './auth.schema';

const router = Router();

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Sign in and receive an httpOnly session cookie
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string, format: password }
 *     responses:
 *       200: { description: Signed in }
 *       401: { description: Invalid credentials }
 *       423: { description: Account temporarily locked }
 *       429: { description: Too many attempts from this address }
 */
router.post('/login', loginRateLimiter, validateBody(loginSchema), login);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: End the current session on the server
 *     tags: [Auth]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       204: { description: Signed out }
 */
router.post('/logout', requireAuth, logout);

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Current administrator
 *     tags: [Auth]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Current administrator }
 *       401: { description: Not signed in }
 */
router.get('/me', requireAuth, me);

export default router;
