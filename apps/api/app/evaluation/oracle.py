from dataclasses import dataclass, field


@dataclass
class OracleResult:
    entity_recall: float
    entity_precision: float
    found_entities: list[str]
    missed_entities: list[str]
    extra_entities: list[str]
    claim_recall: float | None = field(default=None)
    found_claims: list[dict] = field(default_factory=list)
    missed_claims: list[dict] = field(default_factory=list)


def _norm(s: str) -> str:
    return s.strip().lower()


def evaluate_entities(
    approved_names: list[str],
    oracle_names: list[str],
) -> OracleResult:
    approved_map = {_norm(n): n for n in approved_names}
    oracle_map = {_norm(n): n for n in oracle_names}

    found = [oracle_map[k] for k in oracle_map if k in approved_map]
    missed = [oracle_map[k] for k in oracle_map if k not in approved_map]
    extra = [approved_map[k] for k in approved_map if k not in oracle_map]

    recall = len(found) / len(oracle_map) if oracle_map else 1.0
    precision = len(found) / len(approved_map) if approved_map else 0.0

    return OracleResult(
        entity_recall=round(recall, 4),
        entity_precision=round(precision, 4),
        found_entities=found,
        missed_entities=missed,
        extra_entities=extra,
    )


def evaluate_claims(
    approved_claims: list[dict],
    oracle_claims: list[dict],
) -> tuple[float | None, list[dict], list[dict]]:
    if not oracle_claims:
        return None, [], []

    def _key(c: dict) -> tuple[str, str, str]:
        return (_norm(c.get("subject", "")), _norm(c.get("predicate", "")), _norm(c.get("object", "")))

    approved_keys = {_key(c) for c in approved_claims}
    found = [c for c in oracle_claims if _key(c) in approved_keys]
    missed = [c for c in oracle_claims if _key(c) not in approved_keys]
    recall = round(len(found) / len(oracle_claims), 4)

    return recall, found, missed


def evaluate_atlas(
    approved_names: list[str],
    oracle_names: list[str],
    approved_claims: list[dict] | None = None,
    oracle_claims: list[dict] | None = None,
) -> OracleResult:
    result = evaluate_entities(approved_names, oracle_names)
    if oracle_claims is not None:
        claim_recall, found_claims, missed_claims = evaluate_claims(
            approved_claims or [], oracle_claims
        )
        result.claim_recall = claim_recall
        result.found_claims = found_claims
        result.missed_claims = missed_claims
    return result
