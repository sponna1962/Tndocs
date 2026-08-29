function assessOcrText(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, reason: 'empty OCR output' };
  if (value.length < 8) return { ok: false, reason: 'OCR output is suspiciously short' };
  const bad = (value.match(/[�\\_]{3,}|(?:[\\_]{2,})/g) || []).join('').length;
  const symbols = (value.match(/[^\p{L}\p{N}\s.,;:!?()\[\]{}+\-*/=₹%&'"“”‘’]/gu) || []).length;
  if (bad / value.length > 0.08) return { ok: false, reason: 'repeated OCR garbage characters' };
  if (symbols / value.length > 0.35) return { ok: false, reason: 'suspicious symbol density' };
  return { ok: true, reason: '' };
}
module.exports = { assessOcrText };
