import path from 'node:path';
import multer from 'multer';
import { ValidationError } from '../errors/AppError';
import { ErrorCode } from '../errors/errorCodes';
import { env } from '../../config/env';

const ALLOWED_EXTENSIONS = new Set(['.log', '.txt', '']);

/** Firewall log uploads: one plain-text file, kept in memory (never written to disk), size-capped. */
export const firewallLogUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.FIREWALL_UPLOAD_MAX_MB * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(new ValidationError(ErrorCode.FIREWALL_FILE_INVALID));
      return;
    }
    callback(null, true);
  },
}).single('file');
