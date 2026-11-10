function isConfirmedEntry(entry) {
  return (entry.status || "confirmed") === "confirmed";
}

function summarizeEntries(entries) {
  const confirmed = entries.filter(isConfirmedEntry);
  return {
    confirmed: confirmed.length,
    pending: entries.filter(entry => entry.status === "pending").length,
    teams: new Set(confirmed.map(entry => String(entry.team || "").trim() || "(無所属)")).size,
  };
}

module.exports = { isConfirmedEntry, summarizeEntries };
