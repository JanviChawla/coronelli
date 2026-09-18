"""extraction_runs: nullable section_id + document_id for global enrichment runs

Revision ID: l2m3n4o5p6q7
Revises: k1l2m3n4o5p6
Create Date: 2026-09-17
"""

from alembic import op
import sqlalchemy as sa

revision = "l2m3n4o5p6q7"
down_revision = "k1l2m3n4o5p6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # extraction_runs: section_id nullable + new document_id for document-scoped runs
    with op.batch_alter_table("extraction_runs") as batch_op:
        batch_op.alter_column("section_id", existing_type=sa.String(), nullable=True)
        batch_op.add_column(sa.Column("document_id", sa.String(), nullable=True))

    # candidates: section_id nullable for global enrichment candidates
    with op.batch_alter_table("candidates") as batch_op:
        batch_op.alter_column("section_id", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("candidates") as batch_op:
        batch_op.alter_column("section_id", existing_type=sa.String(), nullable=False)

    with op.batch_alter_table("extraction_runs") as batch_op:
        batch_op.drop_column("document_id")
        batch_op.alter_column("section_id", existing_type=sa.String(), nullable=False)
