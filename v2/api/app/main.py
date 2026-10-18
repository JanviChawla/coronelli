"""FastAPI application entry point."""

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db.database import init_db
from app.api.documents import router as documents_router
from app.api.sections import router as sections_router
from app.api.catalog import router as catalog_router
from app.api.extraction import router as extraction_router
from app.api.atlas import router as atlas_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    await init_db()
    yield


app = FastAPI(title="Coronelli v2 API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents_router)
app.include_router(sections_router)
app.include_router(catalog_router)
app.include_router(extraction_router)
app.include_router(atlas_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
