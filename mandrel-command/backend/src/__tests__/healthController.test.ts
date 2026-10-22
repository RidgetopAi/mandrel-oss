import request from 'supertest';
import express from 'express';
import healthRoutes from '../routes/health';

const app = express();
// Mounted under /api to mirror the production server (app.use('/api', healthRoutes)).
app.use('/api', healthRoutes);

describe('Health Controller', () => {
  test('GET /api/health returns status 200', async () => {
    const response = await request(app)
      .get('/api/health')
      .expect(200);

    // getHealth responds { success, data: { status: 'healthy', timestamp, ... } }
    expect(response.body).toHaveProperty('success', true);
    expect(response.body.data).toHaveProperty('status', 'healthy');
    expect(response.body.data).toHaveProperty('timestamp');
  });
});
