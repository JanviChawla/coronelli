import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

load_dotenv(find_dotenv(usecwd=True) or None)
from fastapi.middleware.cors import CORSMiddleware

from app.api.atlas import router as atlas_router
from app.api.candidates import router as candidates_router
from app.api.extraction import router as extraction_router
from app.api.sources import router as sources_router
from app.api.synthesis import router as synthesis_router
from app.db.base import Base
from app.db.engine import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    yield


app = FastAPI(lifespan=lifespan)

_cors_origins = os.getenv(
    "CORONELLI_CORS_ORIGINS",
    "http://localhost:5173,http://localhost:8000",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sources_router)
app.include_router(extraction_router)
app.include_router(candidates_router)
app.include_router(synthesis_router)
app.include_router(atlas_router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


_static = Path(__file__).parent / "static"
if _static.is_dir():
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
