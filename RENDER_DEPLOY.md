# Render deploy

## Backend Web Service

1. Render Dashboard -> New -> Web Service.
2. Select the GitHub repository and branch `main`.
3. Root Directory: leave empty.
4. Runtime: `Node`.
5. Build Command: `npm install`.
6. Start Command: `npm start`.
7. Health Check Path: `/health`.

Add these environment variables to the Render backend service:

```text
DATABASE_URL=<Render PostgreSQL Internal Database URL>
CORS_ORIGIN=https://<your-frontend>.vercel.app
MAX_RESULT_NS=60000000000
SUBMIT_RATE_LIMIT=30
NODE_VERSION=20
```

Do not expose `DATABASE_URL` in the frontend project.

## PostgreSQL

Create Render -> New -> PostgreSQL. Copy its **Internal Database URL** into the backend service's `DATABASE_URL`. The server creates its tables automatically on the first API request.

## Frontend connection

In the Vercel frontend project, set:

```text
VITE_API_BASE=https://<your-render-service>.onrender.com
```

Redeploy the frontend after changing this variable. Then put the final Vercel frontend URL in the backend's `CORS_ORIGIN` value and redeploy the backend.

## Railway migration

The database is not moved automatically. Keep Railway running until the Render database is ready, export/import the PostgreSQL data if existing scores must be preserved, then update `DATABASE_URL` on Render. If old scores are not needed, Render will create empty tables automatically.
