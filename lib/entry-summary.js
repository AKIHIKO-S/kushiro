function isConfirmedEntry(entry) {
  return (entry.status || "confirmed") === "confirmed";
}

function savedEntryFee(entry) {
  if (entry.fee == null || String(entry.fee).trim() === "") return null;
  const fee = Number(entry.fee);
  // 申込を通らない旧データでは、列の既定値0は金額が未設定である場合と区別できない。
  if (!Number.isSafeInteger(fee) || fee < 0 || (fee === 0 && !entry.submission_id)) return null;
  return fee;
}

function summarizeEntries(entries) {
  const confirmed = entries.filter(isConfirmedEntry);
  return {
    confirmed: confirmed.length,
    pending: entries.filter(entry => entry.status === "pending").length,
    teams: new Set(confirmed.map(entry => String(entry.team || "").trim() || "(無所属)")).size,
  };
}

module.exports = { isConfirmedEntry, savedEntryFee, summarizeEntries };
