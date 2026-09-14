from fastapi import FastAPI

from app.api.workspaces import router as workspaces_router

app = FastAPI()
app.include_router(workspaces_router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
