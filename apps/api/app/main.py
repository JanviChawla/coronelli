from fastapi import FastAPI

from app.api.sources import router as sources_router
from app.api.workspaces import router as workspaces_router

app = FastAPI()
app.include_router(workspaces_router)
app.include_router(sources_router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
