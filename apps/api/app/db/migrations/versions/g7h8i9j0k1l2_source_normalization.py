"""source normalization: raw_text, body offsets, section_kind

Revision ID: g7h8i9j0k1l2
Revises: f6a7b8c9d0e1
Create Date: 2026-09-15 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "g7h8i9j0k1l2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column("raw_text", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("narrative_body_start", sa.Integer(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("narrative_body_end", sa.Integer(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("normalization_diagnostics", sa.JSON(), nullable=True),
    )
    op.add_column(
        "source_sections",
        sa.Column(
            "section_kind",
            sa.String(),
            nullable=False,
            server_default="narrative",
        ),
    )


def downgrade() -> None:
    op.drop_column("source_sections", "section_kind")
    op.drop_column("source_documents", "normalization_diagnostics")
    op.drop_column("source_documents", "narrative_body_end")
    op.drop_column("source_documents", "narrative_body_start")
    op.drop_column("source_documents", "raw_text")
