import path from 'node:path';
import swaggerJsdoc from 'swagger-jsdoc';

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Nuvytrix API',
      version: '0.1.0',
      description:
        'Home network monitoring and management. All endpoints except /health and /auth/login require the session cookie.',
    },
    servers: [{ url: '/api' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'nuvytrix_session' },
      },
    },
  },
  // Compiled output has .js route files, development runs the .ts sources.
  apis: [path.join(__dirname, '../modules/**/*.routes.{ts,js}')],
});
