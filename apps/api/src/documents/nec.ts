import { PDFDocument } from "pdf-lib";
import { irsFile, NEC } from "./irs.js";

export interface Party {
  name: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  tin: string;
}

export interface NecInput {
  year: number;
  payer: Party;
  recipient: Party;
  /** box 1, USD with two decimals */
  nonemployeeCompensation: string;
}

/** SSN (123-45-6789) or EIN (12-3456789), dashes optional. */
export function normalizeTin(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(d)) return null;
  return raw.includes("-") && /^\d{2}-\d{7}$/.test(raw.trim()) ? `${d.slice(0, 2)}-${d.slice(2)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/** A value that does not fit a box of the form (the boxes have fixed lengths, e.g. a 2-letter state). */
export class NecFieldError extends Error {}

/**
 * Fills Copy B of the official Form 1099-NEC and returns only Copy B and its back (Instructions for Recipient).
 * Copy A is never part of the output: the IRS says a self-printed Copy A cannot be filed.
 * `flatten: false` keeps the fields readable (tests).
 */
export async function fill1099Nec(input: NecInput, o: { flatten?: boolean } = {}): Promise<Uint8Array> {
  if (input.year < NEC.firstYear) throw new Error(`Form 1099-NEC Rev. ${NEC.revision} is for ${NEC.firstYear} and later`);
  const doc = await PDFDocument.load(irsFile(NEC.file));
  const form = doc.getForm();
  const f = NEC.copyB;
  const set = (name: string, raw: string | undefined, label?: string, hint?: string) => {
    const v = raw?.trim();
    if (!v) return;
    const field = form.getTextField(name);
    const max = field.getMaxLength();
    if (max !== undefined && v.length > max) throw new NecFieldError(`${label ?? name}: at most ${max} characters${hint ? ` — ${hint}` : ""}`);
    field.setText(v);
  };
  const STATE = "use the two-letter code, e.g. IL";
  const COUNTRY = "use the two-letter code, e.g. US";
  set(f.calendarYear, String(input.year));
  set(f.payerName, input.payer.name);
  set(f.payerStreet, input.payer.street);
  set(f.payerCity, input.payer.city);
  set(f.payerState, input.payer.state?.toUpperCase(), "Payer state", STATE);
  set(f.payerZip, input.payer.zip);
  set(f.payerCountry, input.payer.country?.toUpperCase(), "Payer country", COUNTRY);
  set(f.payerPhone, input.payer.phone);
  set(f.payerTin, input.payer.tin);
  set(f.recipientTin, input.recipient.tin);
  set(f.recipientName, input.recipient.name);
  set(f.recipientStreet, input.recipient.street);
  set(f.recipientCity, input.recipient.city);
  set(f.recipientState, input.recipient.state?.toUpperCase(), "Recipient state", STATE);
  set(f.recipientZip, input.recipient.zip);
  set(f.recipientCountry, input.recipient.country?.toUpperCase(), "Recipient country", COUNTRY);
  set(f.box1NonemployeeCompensation, input.nonemployeeCompensation);
  // tests read the fields back: the whole file, nothing flattened (never served)
  if (o.flatten === false) return doc.save();
  form.flatten();
  // keep Copy B and its back only; remove from the end so indices stay valid
  for (let i = doc.getPageCount() - 1; i >= 0; i--) if (!NEC.recipientPages.includes(i)) doc.removePage(i);
  return doc.save();
}
