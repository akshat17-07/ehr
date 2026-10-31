// Local development server: `npm run dev`. Sets NODE_ENV before config is read.
process.env.NODE_ENV ??= 'development';

const { serve } = await import('@hono/node-server');
const { createApp } = await import('./app.js');

serve({ fetch: createApp().fetch, port: 3000 }, (info) => {
  console.log(`API running on http://localhost:${info.port}`);
});

export {};
