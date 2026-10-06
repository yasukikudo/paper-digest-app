// Display labels that are not stored in Firestore.
// Field names come from each day document (`days.fields`); DEFAULT_FIELDS is used only for
// days written before schema version 6, which have no `fields`.

export const DEFAULT_FIELDS = [
  { id: "ir", name: "International Relations" },
  { id: "cp", name: "Comparative Politics" },
  { id: "ap", name: "American Politics" },
  { id: "pb", name: "Political Behavior & Public Opinion" },
  { id: "pm", name: "Political Methodology" },
  { id: "pt", name: "Political Theory" },
  { id: "other", name: "Other" },
];

// The six sections of a full-text summary, in display order
export const SECTION_LABELS = [
  ["background", "Question & background"],
  ["theory", "Theory & argument"],
  ["design", "Design & data"],
  ["findings", "Main findings"],
  ["robustness", "Robustness & limitations"],
  ["implications", "Implications"],
];

export const SOURCE_LABELS = { oa: "OA", own_pdf: "Own PDF", import: "Imported" };

// Library statuses, in display order
export const STATUSES = [
  ["to_read", "To read"],
  ["read", "Read"],
];

export const REQUEST_LABELS = {
  pending: "Full text requested · waiting",
  processing: "Full text being summarized…",
  done: "Full-text request done",
  failed: "Full-text request failed",
  cancelled: "Full-text request cancelled",
};

export const LANGUAGE_NAMES = {
  ja: "Japanese", en: "English", zh: "Chinese", ko: "Korean",
  de: "German", fr: "French", es: "Spanish",
};
