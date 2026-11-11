import { parseCalendarDate, trialStatus, isDueForReminder, addDays, dateKey } from "./trial-dates.mjs";
import { formatCentsAsAmount, validateTrialInput } from "./trial-validation.mjs";
import { buildTrialReminderICS, sanitizeFilename, isReminderInFuture } from "./ics.mjs";
import { formatUsd, formatSignedUsd } from "./budget-calculations.mjs";
import { sandboxNote } from "./budget-templates.mjs";

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const refreshButton = document.getElementById("refresh-button");
const refreshIcon = document.getElementById("refresh-icon");
const summaryTracked = document.getElementById("summary-tracked");
const summaryActive = document.getElementById("summary-active");
const summaryPaused = document.getElementById("summary-paused");

const trialsList = document.getElementById("trials-list");
const deadlinesList = document.getElementById("deadlines-list");
const addTrialButton = document.getElementById("add-trial-button");

const trialDialog = document.getElementById("trial-dialog");
const trialDialogTitle = document.getElementById("trial-dialog-title");
const trialForm = document.getElementById("trial-form");
const formStepEl = trialForm.querySelector('[data-step="form"]');
const reviewStepEl = trialForm.querySelector('[data-step="review"]');
const reviewList = document.getElementById("review-list");
const trialSaveError = document.getElementById("trial-save-error");

const trialFields = {
  serviceName: document.getElementById("trial-service-name"),
  trialEndDate: document.getElementById("trial-end-date"),
  renewalPrice: document.getElementById("trial-price"),
  currency: document.getElementById("trial-currency"),
  billingFrequency: document.getElementById("trial-frequency"),
  reminderLeadDays: document.getElementById("trial-reminder"),
};
const importContextEl = document.getElementById("import-context");
const importWarningsEl = document.getElementById("import-warnings");
const reviewDuplicateWarning = document.getElementById("review-duplicate-warning");

const importTrialButton = document.getElementById("import-trial-button");
const importDialog = document.getElementById("import-dialog");
const importPrivacyDetail = document.getElementById("import-privacy-detail");
const importTextArea = document.getElementById("import-text");
const importTextCount = document.getElementById("import-text-count");
const importErrorEl = document.getElementById("error-import");
const importStatusEl = document.getElementById("import-status");
const extractButton = document.getElementById("extract-button");
const extractSpinner = document.getElementById("extract-spinner");
const extractLabel = document.getElementById("extract-label");

const calendarDialog = document.getElementById("calendar-dialog");
const calendarServiceNameEl = document.getElementById("calendar-service-name");
const calendarEndDateEl = document.getElementById("calendar-end-date");
const calendarDateInput = document.getElementById("calendar-reminder-date");
const calendarTimeInput = document.getElementById("calendar-reminder-time");
const calendarTimezoneNote = document.getElementById("calendar-timezone-note");
const calendarPastWarning = document.getElementById("calendar-past-warning");
const calendarDownloadButton = document.getElementById("calendar-download-button");

const budgetAmountInput = document.getElementById("budget-amount");
const budgetSaveButton = document.getElementById("budget-save-button");
const budgetClearButton = document.getElementById("budget-clear-button");
const budgetSaveError = document.getElementById("budget-save-error");
const budgetSummaryBudget = document.getElementById("budget-summary-budget");
const budgetSummaryTracked = document.getElementById("budget-summary-tracked");
const budgetSummaryDiff = document.getElementById("budget-summary-diff");
const budgetSummaryDiffLabel = document.getElementById("budget-summary-diff-label");
const budgetSandboxNoteEl = document.getElementById("budget-sandbox-note");
const budgetScenarioNoteEl = document.getElementById("budget-scenario-note");
const budgetSuggestedQuestionsEl = document.getElementById("budget-suggested-questions");
const budgetAskForm = document.getElementById("budget-ask-form");
const budgetAskInput = document.getElementById("budget-ask-input");
const budgetAskButton = document.getElementById("budget-ask-button");
const budgetAnswerEl = document.getElementById("budget-answer");

let busy = false;
let trialsBusy = false;
let trials = [];
let trialsLoaded = false;
let editingTrialId = null;
let pendingReviewValue = null;
let pendingImportSource = false;
let importBusy = false;
let lastDateKey = null;
let calendarTrial = null;
let budgetBusy = false;
let askBusy = false;
// The "currently selected scenario" for the hypothetical-exclusion
// conversation — which tracked records are being hypothetically excluded
// from the total right now. Kept in memory only (never persisted, never
// sent anywhere but back to the stateless /api/budget/query endpoint), so
// it resets on reload, matching "keep chat/session context temporary."
let scenarioExcludeIds = [];
let scenarioRecords = [];

const ICONS = {
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 2.6 18a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  ban:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.5 5.5 13 13"/></svg>',
  tag:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 12.6 12.6 20.4a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1 0-2.8L11.4 3.6a2 2 0 0 1 1.4-.6H19a2 2 0 0 1 2 2v6.6a2 2 0 0 1-.6 1.4Z"/><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  chevron:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7Z"/></svg>',
  inbox:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 12 3 5h18l-2 7"/><path d="M3 12v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/></svg>',
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
  bell:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="M12 14v3M10.5 15.5h3"/></svg>',
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function icon(name, extraClass = "") {
  const span = el("span", {
    className: `icon${extraClass ? " " + extraClass : ""}`,
    "aria-hidden": "true",
  });
  span.innerHTML = ICONS[name] ?? "";
  return span;
}

function formatDateTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  // dateStyle/timeStyle cannot be combined with timeZoneName per the Intl
  // spec, so the format is spelled out explicitly instead.
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatPrice(price) {
  if (!price) return null;
  const amount = Number(price.value);
  const hasCents = amount % 1 !== 0;
  const formatted = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: price.currencyCode,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
  const unit = price.intervalUnit?.toLowerCase() ?? "cycle";
  const count = price.intervalCount ?? 1;
  const unitLabel = count > 1 ? `${count} ${unit}s` : unit;
  return `${formatted}/${unitLabel}`;
}

function formatTrialLabel(trial) {
  if (!trial) return null;
  const unit = trial.intervalUnit?.toLowerCase() ?? "cycle";
  return `${trial.intervalCount}-${unit} free trial`;
}

function formatCalendarDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parseCalendarDate(value));
}

function formatManualTrialPrice(trial) {
  const amount = trial.renewalPriceCents / 100;
  const hasCents = trial.renewalPriceCents % 100 !== 0;
  const formatted = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: trial.currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
  const unit = trial.billingFrequency === "yearly" ? "year" : "month";
  return `${formatted}/${unit}`;
}

function presentTrialStatus(status) {
  if (status.kind === "passed") {
    return {
      label: "Trial end date passed — check with provider",
      cls: "status-trial-passed",
      icon: "ban",
    };
  }
  if (status.kind === "today") {
    return { label: "Ends today", cls: "status-trial-today", icon: "alert" };
  }
  if (status.kind === "soon") {
    return { label: "Ending soon", cls: "status-trial-soon", icon: "alert" };
  }
  return {
    label: `Trial ends in ${status.days} day${status.days === 1 ? "" : "s"}`,
    cls: "status-trial-normal",
    icon: "clock",
  };
}

function presentStatus(status) {
  if (status === "ACTIVE") return { label: "Active", cls: "status-active", icon: "check" };
  if (status === "SUSPENDED") return { label: "Paused", cls: "status-paused", icon: "pause" };
  return { label: "Needs attention", cls: "status-attention", icon: "alert" };
}

function contextMessage(summary) {
  if (summary.status === "ACTIVE") {
    return "This subscription is active. You can pause it at any time — billing stops immediately until you resume it.";
  }
  if (summary.status === "SUSPENDED") {
    return "This subscription is paused. Resume it to re-enable billing under the plan's terms.";
  }
  return `PayPal reports a status of ${summary.status} for this subscription, so no action is available here.`;
}

function showBanner(kind, message) {
  banner.textContent = message;
  banner.className = `banner banner-${kind}`;
  banner.hidden = false;
  clearTimeout(showBanner._timer);
  showBanner._timer = setTimeout(() => {
    banner.hidden = true;
  }, 6000);
}

function setSummary(tracked, active, paused) {
  summaryTracked.textContent = tracked;
  summaryActive.textContent = active;
  summaryPaused.textContent = paused;
}

function detailRow(label, value) {
  return el("div", { className: "detail-row" }, [
    el("dt", { text: label }),
    el("dd", { text: value ?? "Not available" }),
  ]);
}

function billingFact(summary, nextBillingText) {
  const label = el("span", {
    className: "fact-label",
    text: summary.status === "SUSPENDED" ? "Billing" : "Next billing",
  });

  let valueNode;
  if (summary.status === "SUSPENDED") {
    valueNode = el("div", { className: "fact-value" }, [
      icon("ban"),
      el("span", { text: "Billing paused" }),
    ]);
  } else if (nextBillingText) {
    const note = summary.nextBillingConfirmed ? null : "Not yet confirmed by PayPal";
    valueNode = el("div", {}, [
      el("div", { className: "fact-value" }, [icon("clock"), el("span", { text: nextBillingText })]),
      note ? el("span", { className: "fact-note", text: note }) : null,
    ]);
  } else {
    valueNode = el("div", { className: "fact-value", text: "Not available" });
  }

  return el("div", { className: "fact" }, [label, valueNode]);
}

function renderSkeleton() {
  setSummary("—", "—", "—");

  const card = el("div", { className: "skel-card" }, [
    el("div", { className: "skel-row" }, [
      el("div", { className: "skel skel-circle" }),
      el("div", {}, [
        el("div", { className: "skel skel-line", style: "width:150px;margin-bottom:8px;" }),
        el("div", { className: "skel skel-line", style: "width:100px;height:10px;" }),
      ]),
    ]),
    el("div", { className: "skel-facts" }, [
      el("div", { className: "skel skel-fact" }),
      el("div", { className: "skel skel-fact" }),
      el("div", { className: "skel skel-fact" }),
    ]),
    el("div", { className: "skel skel-btn" }),
  ]);

  app.replaceChildren(card);
}

function renderEmpty(message) {
  setSummary("0", "0", "0");
  app.replaceChildren(
    el("div", { className: "state-panel" }, [icon("inbox"), el("p", { text: message })])
  );
}

function renderErrorState(message) {
  const retry = el("button", { type: "button", className: "btn btn-outline", text: "Retry" });
  retry.addEventListener("click", load);
  app.replaceChildren(
    el("div", { className: "state-panel is-error" }, [icon("alert"), el("p", { text: message }), retry])
  );
}

function renderCard(summary) {
  const status = presentStatus(summary.status);
  const price = formatPrice(summary.recurringPrice);
  const trialLabel = formatTrialLabel(summary.trial);
  const nextBillingText = summary.status === "SUSPENDED" ? null : formatDateTime(summary.nextBillingTime);
  const lastPaymentText = formatDateTime(summary.lastPaymentTime);
  const updatedAtText = formatDateTime(summary.statusUpdateTime);
  const serviceName = (summary.planName ?? summary.serviceName ?? "PayPal subscription").split(":")[0].trim();

  const top = el("div", { className: "sub-card-top" }, [
    el("div", { className: "sub-identity" }, [
      el("div", { className: "monogram" }, [icon("play")]),
      el("div", {}, [
        el("div", { className: "sub-name", text: serviceName }),
        el("span", { className: "sub-tagline", text: "PayPal sandbox subscription" }),
      ]),
    ]),
    el("span", { className: `status-badge ${status.cls}` }, [
      icon(status.icon),
      el("span", { text: status.label }),
    ]),
  ]);

  const facts = el("div", { className: "sub-facts" }, [
    el("div", { className: "fact" }, [
      el("span", { className: "fact-label", text: "Plan price" }),
      el("div", { className: "fact-value", text: price ?? "Not available" }),
    ]),
    el("div", { className: "fact" }, [
      el("span", { className: "fact-label", text: "Plan terms" }),
      trialLabel
        ? el("span", { className: "trial-chip" }, [icon("tag"), el("span", { text: trialLabel })])
        : el("div", { className: "fact-value", text: "No trial" }),
    ]),
    billingFact(summary, nextBillingText),
  ]);

  const actions = el("div", { className: "sub-actions" });
  if (summary.status === "ACTIVE") {
    const pauseButton = el("button", { type: "button", className: "btn btn-outline", text: "Pause subscription" });
    pauseButton.addEventListener("click", () => handleAction("pause", pauseButton, summary));
    actions.appendChild(pauseButton);
  } else if (summary.status === "SUSPENDED") {
    const resumeButton = el("button", { type: "button", className: "btn btn-primary", text: "Resume subscription" });
    resumeButton.addEventListener("click", () => handleAction("resume", resumeButton, summary));
    actions.appendChild(resumeButton);
  }

  const details = el("details", { className: "sub-details" }, [
    el("summary", {}, [icon("chevron", "chevron"), el("span", { text: "Subscription details" })]),
    el("dl", { className: "detail-rows" }, [
      detailRow("Subscription ID", summary.subscriptionId),
      detailRow("Plan ID", summary.planId),
      detailRow("Plan name", summary.planName),
      detailRow("PayPal status", summary.status),
      detailRow("Status updated", updatedAtText),
      detailRow("Last payment", lastPaymentText),
      detailRow("Environment", summary.environment),
    ]),
  ]);

  const card = el("div", { className: "sub-card" }, [top, facts, actions, details]);

  const context = el("div", { className: "context-note" }, [
    icon("info"),
    el("p", { text: contextMessage(summary) }),
  ]);

  return el("div", { className: "paypal-subscription", "data-subscription-id": summary.subscriptionId }, [card, context]);
}

function renderCards(subscriptions) {
  const cards = subscriptions.map((item) => item.summary ? renderCard(item.summary) :
    el("div", { className: "state-panel is-error" }, [
      icon("alert"),
      el("p", { text: `${item.serviceName}: PayPal data is unavailable. ${item.error}` }),
    ]));
  app.replaceChildren(...cards);
  const incomplete = subscriptions.some((item) => !item.summary);
  setSummary(String(subscriptions.length),
    incomplete ? "—" : String(subscriptions.filter((item) => item.summary.status === "ACTIVE").length),
    incomplete ? "—" : String(subscriptions.filter((item) => item.summary.status === "SUSPENDED").length));
}

async function load() {
  refreshIcon.classList.add("is-spinning");
  renderSkeleton();

  try {
    const response = await fetch("/api/subscriptions", { headers: { Accept: "application/json" } });
    const data = await response.json();

    if (response.status === 404) {
      renderEmpty(data.error ?? "No subscriptions yet.");
      return;
    }
    if (!response.ok) {
      renderErrorState(data.error ?? "Could not load the subscriptions.");
      return;
    }

    renderCards(data.subscriptions);
  } catch {
    renderErrorState("Could not reach the Subscription Shield server.");
  } finally {
    refreshIcon.classList.remove("is-spinning");
  }
}

async function handleAction(kind, button, subscription) {
  if (busy) return;

  const serviceName = (subscription.planName ?? subscription.serviceName ?? "this subscription").split(":")[0].trim();
  const confirmed = window.confirm(
    kind === "pause"
      ? `Pause ${serviceName}? This suspends its PayPal sandbox billing until it is resumed.`
      : `Resume ${serviceName}? This re-enables its PayPal sandbox billing under the plan's terms.`
  );
  if (!confirmed) return;

  busy = true;
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = kind === "pause" ? "Pausing…" : "Resuming…";
  refreshButton.disabled = true;

  try {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(subscription.subscriptionId)}/${kind}`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const data = await response.json();

    if (!response.ok) {
      showBanner("error", data.error ?? `Could not ${kind} the subscription.`);
    } else if (data.verified) {
      showBanner(
        "success",
        kind === "pause"
          ? `${serviceName} paused — PayPal confirmed the suspended status.`
          : `${serviceName} resumed — PayPal confirmed the active status.`
      );
    } else {
      showBanner(
        "warning",
        `PayPal accepted the request but hasn't confirmed the new status yet. Refresh to check again.`
      );
    }

    await Promise.all([load(), loadBudgetSummary()]);
  } catch {
    showBanner("error", `Could not reach the server to ${kind} the subscription.`);
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = originalText;
  } finally {
    busy = false;
    refreshButton.disabled = false;
  }
}

// ---------- Free trials: list + upcoming deadlines ----------

function renderDeadlines() {
  if (trials.length === 0) {
    deadlinesList.replaceChildren(
      el("p", { className: "panel-empty", text: "Add a free trial to see deadline alerts here." })
    );
    return;
  }

  const due = trials.filter((trial) => isDueForReminder(trial));

  if (due.length === 0) {
    deadlinesList.replaceChildren(
      el("p", {
        className: "panel-empty",
        text: "No trials are due within their reminder window right now.",
      })
    );
    return;
  }

  const items = due
    .slice()
    .sort((a, b) => a.trialEndDate.localeCompare(b.trialEndDate))
    .map((trial) => {
      const status = presentTrialStatus(trialStatus(trial));
      return el("li", { className: `deadline-item deadline-${status.cls}` }, [
        icon(status.icon),
        el("div", {}, [
          el("span", { className: "deadline-service", text: trial.serviceName }),
          el("span", {
            className: "deadline-detail",
            text: `${status.label} · ${formatCalendarDate(trial.trialEndDate)}`,
          }),
        ]),
      ]);
    });

  deadlinesList.replaceChildren(el("ul", { className: "deadline-list" }, items));
}

function trialCardNode(trial) {
  const status = presentTrialStatus(trialStatus(trial));

  const isAiImport = trial.source === "ai_import";
  const nameRow = el("div", { className: "trial-name-row" }, [
    el("span", { className: "trial-name", text: trial.serviceName }),
    el("span", { className: `badge ${isAiImport ? "badge-ai-import" : "badge-manual"}` }, [
      el("span", { text: isAiImport ? "Imported from text" : "Manually added" }),
    ]),
  ]);

  const subline = el("span", {
    className: "trial-subline",
    text: `Ends ${formatCalendarDate(trial.trialEndDate)} · ${formatManualTrialPrice(trial)}`,
  });

  const top = el("div", { className: "trial-card-top" }, [
    el("div", {}, [nameRow, subline]),
    el("span", { className: `status-badge ${status.cls}` }, [
      icon(status.icon),
      el("span", { text: status.label }),
    ]),
  ]);

  const editButton = el("button", { type: "button", className: "btn btn-outline btn-small" }, [
    icon("pencil"),
    el("span", { text: "Edit" }),
  ]);
  editButton.addEventListener("click", () => openTrialDialog(trial));

  const calendarButton = el("button", { type: "button", className: "btn btn-outline btn-small" }, [
    icon("calendar"),
    el("span", { text: "Add to calendar" }),
  ]);
  calendarButton.addEventListener("click", () => openCalendarDialog(trial));

  const deleteButton = el(
    "button",
    { type: "button", className: "btn btn-outline btn-small btn-danger-text" },
    [icon("trash"), el("span", { text: "Delete" })]
  );
  deleteButton.addEventListener("click", () => handleDeleteTrial(trial, deleteButton));

  const actions = el("div", { className: "trial-actions" }, [editButton, calendarButton, deleteButton]);
  const reminderNote = el("span", {
    className: "trial-reminder-note",
    text: `Reminder set for ${trial.reminderLeadDays} day${trial.reminderLeadDays === 1 ? "" : "s"} before.`,
  });

  return el("div", { className: "trial-card" }, [top, reminderNote, actions]);
}

function renderTrials() {
  renderDeadlines();

  if (!trialsLoaded) {
    trialsList.replaceChildren(
      el("div", { className: "skel-card skel-card-compact" }, [
        el("div", { className: "skel skel-line", style: "width:55%;margin-bottom:10px;" }),
        el("div", { className: "skel skel-line", style: "width:35%;" }),
      ])
    );
    return;
  }

  if (trials.length === 0) {
    trialsList.replaceChildren(
      el("div", { className: "state-panel" }, [
        icon("inbox"),
        el("p", { text: "No free trials tracked yet. Add one to get reminders here." }),
      ])
    );
    return;
  }

  trialsList.replaceChildren(el("div", { className: "trial-card-list" }, trials.map(trialCardNode)));
}

async function loadTrials() {
  try {
    const response = await fetch("/api/trials", { headers: { Accept: "application/json" } });
    const data = await response.json();

    if (!response.ok) {
      trialsList.replaceChildren(
        el("div", { className: "state-panel is-error" }, [
          icon("alert"),
          el("p", { text: data.error ?? "Could not load your tracked trials." }),
        ])
      );
      return;
    }

    trials = data.trials ?? [];
    trialsLoaded = true;
    renderTrials();
  } catch {
    trialsList.replaceChildren(
      el("div", { className: "state-panel is-error" }, [
        icon("alert"),
        el("p", { text: "Could not reach the server to load your tracked trials." }),
      ])
    );
  }
}

async function handleDeleteTrial(trial, button) {
  if (trialsBusy) return;

  const confirmed = window.confirm(
    `Delete the trial tracking for "${trial.serviceName}"? This only removes it from Subscription Shield — it won't cancel any billing with the provider.`
  );
  if (!confirmed) return;

  trialsBusy = true;
  button.disabled = true;
  addTrialButton.disabled = true;

  try {
    const response = await fetch(`/api/trials/${encodeURIComponent(trial.id)}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showBanner("error", data.error ?? "Could not delete this trial.");
      return;
    }
    showBanner("success", `Removed "${trial.serviceName}" from your tracked trials.`);
    await loadTrials();
  } catch {
    showBanner("error", "Could not reach the server to delete this trial.");
  } finally {
    trialsBusy = false;
    addTrialButton.disabled = false;
  }
}

// ---------- Trial dialog: add / edit, with a review step before saving ----------

function clearFieldErrors() {
  for (const key of Object.keys(trialFields)) {
    const errorEl = document.getElementById(`error-${key}`);
    if (errorEl) errorEl.textContent = "";
    trialFields[key].removeAttribute("aria-invalid");
  }
  trialSaveError.textContent = "";
}

function showFieldErrors(fieldErrors) {
  clearFieldErrors();
  let firstField = null;
  for (const [key, message] of Object.entries(fieldErrors)) {
    const errorEl = document.getElementById(`error-${key}`);
    const field = trialFields[key];
    if (errorEl) errorEl.textContent = message;
    if (field) {
      field.setAttribute("aria-invalid", "true");
      firstField ??= field;
    }
  }
  if (firstField) firstField.focus();
}

function showStep(step) {
  const showingForm = step === "form";
  formStepEl.hidden = !showingForm;
  reviewStepEl.hidden = showingForm;
}

function setFieldNote(key, quote) {
  const noteEl = document.getElementById(`note-${key}`);
  if (noteEl) noteEl.textContent = quote ? `From your text: "${quote}"` : "";
}

function clearFieldNotes() {
  for (const key of ["serviceName", "trialEndDate", "renewalPrice", "currency", "billingFrequency"]) {
    setFieldNote(key, null);
  }
}

function findLikelyDuplicate(serviceName) {
  const needle = serviceName.trim().toLowerCase();
  return trials.find((t) => t.id !== editingTrialId && t.serviceName.trim().toLowerCase() === needle);
}

function openTrialDialog(trial = null) {
  editingTrialId = trial?.id ?? null;
  pendingImportSource = false;
  trialDialogTitle.textContent = trial ? "Edit free trial" : "Add free trial";
  clearFieldErrors();
  clearFieldNotes();
  importContextEl.hidden = true;
  reviewDuplicateWarning.textContent = "";

  trialFields.serviceName.value = trial?.serviceName ?? "";
  trialFields.trialEndDate.value = trial?.trialEndDate ?? "";
  trialFields.renewalPrice.value = trial ? formatCentsAsAmount(trial.renewalPriceCents) : "";
  trialFields.currency.value = "USD";
  trialFields.billingFrequency.value = trial?.billingFrequency ?? "monthly";
  trialFields.reminderLeadDays.value = String(trial?.reminderLeadDays ?? 3);

  showStep("form");
  trialDialog.showModal();
  trialFields.serviceName.focus();
}

// Opens the same Add/Edit dialog, but prefilled from an AI extraction
// result rather than blank. Always a new trial (never opened for edits).
function openImportPrefillDialog(extraction) {
  editingTrialId = null;
  pendingImportSource = true;
  trialDialogTitle.textContent = "Add free trial";
  clearFieldErrors();
  reviewDuplicateWarning.textContent = "";

  trialFields.serviceName.value = extraction.serviceName ?? "";
  trialFields.trialEndDate.value = extraction.trialEndDate ?? "";
  trialFields.renewalPrice.value = extraction.renewalPrice ?? "";
  trialFields.currency.value = "USD";
  trialFields.billingFrequency.value = extraction.billingFrequency ?? "monthly";
  trialFields.reminderLeadDays.value = "3";

  setFieldNote("serviceName", extraction.serviceNameQuote);
  setFieldNote("trialEndDate", extraction.trialEndDateQuote);
  setFieldNote("renewalPrice", extraction.renewalPriceQuote);
  setFieldNote("currency", extraction.currencyQuote);
  setFieldNote("billingFrequency", extraction.billingFrequencyQuote);

  importWarningsEl.replaceChildren(...(extraction.warnings ?? []).map((text) => el("li", { text })));
  importContextEl.hidden = false;

  showStep("form");
  trialDialog.showModal();

  const firstEmpty = ["serviceName", "trialEndDate", "renewalPrice"]
    .map((key) => trialFields[key])
    .find((field) => !field.value);
  (firstEmpty ?? trialFields.serviceName).focus();
}

function closeTrialDialog() {
  trialDialog.close();
}

function collectFormInput() {
  return {
    serviceName: trialFields.serviceName.value,
    trialEndDate: trialFields.trialEndDate.value,
    renewalPrice: trialFields.renewalPrice.value,
    currency: trialFields.currency.value,
    billingFrequency: trialFields.billingFrequency.value,
    reminderLeadDays: trialFields.reminderLeadDays.value,
  };
}

function renderReview(value) {
  const rows = [
    ["Service name", value.serviceName],
    ["Trial end date", formatCalendarDate(value.trialEndDate)],
    ["Renewal price", `${formatCentsAsAmount(value.renewalPriceCents)} ${value.currency}`],
    ["Billing frequency", value.billingFrequency === "yearly" ? "Yearly" : "Monthly"],
    ["Remind me", `${value.reminderLeadDays} day${value.reminderLeadDays === 1 ? "" : "s"} before`],
  ];

  const status = trialStatus({ trialEndDate: value.trialEndDate, reminderLeadDays: value.reminderLeadDays });
  if (status.kind === "passed") {
    rows.push(["Note", "This trial end date has already passed."]);
  }

  reviewList.replaceChildren(
    ...rows.map(([label, text]) =>
      el("div", { className: "detail-row" }, [el("dt", { text: label }), el("dd", { text })])
    )
  );
}

function handleReviewClick() {
  clearFieldErrors();
  const validation = validateTrialInput(collectFormInput());

  if (!validation.valid) {
    showFieldErrors(validation.errors);
    return;
  }

  pendingReviewValue = validation.value;
  renderReview(validation.value);

  const duplicate = findLikelyDuplicate(validation.value.serviceName);
  reviewDuplicateWarning.textContent = duplicate
    ? `You already have a trial tracked for "${duplicate.serviceName}" (ends ${formatCalendarDate(duplicate.trialEndDate)}). Saving will add a separate entry.`
    : "";

  showStep("review");
  trialForm.querySelector('[data-action="save"]').focus();
}

async function handleSaveClick() {
  if (!pendingReviewValue || trialsBusy) return;

  trialsBusy = true;
  const saveButton = trialForm.querySelector('[data-action="save"]');
  const originalText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  trialSaveError.textContent = "";

  const body = {
    serviceName: pendingReviewValue.serviceName,
    trialEndDate: pendingReviewValue.trialEndDate,
    renewalPrice: formatCentsAsAmount(pendingReviewValue.renewalPriceCents),
    currency: pendingReviewValue.currency,
    billingFrequency: pendingReviewValue.billingFrequency,
    reminderLeadDays: pendingReviewValue.reminderLeadDays,
    ...(pendingImportSource ? { source: "ai_import" } : {}),
  };

  try {
    const url = editingTrialId ? `/api/trials/${encodeURIComponent(editingTrialId)}` : "/api/trials";
    const method = editingTrialId ? "PUT" : "POST";
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    if (!response.ok) {
      if (data.fieldErrors) {
        showStep("form");
        showFieldErrors(data.fieldErrors);
      } else {
        trialSaveError.textContent = data.error ?? "Could not save this trial.";
      }
      return;
    }

    showBanner(
      "success",
      editingTrialId
        ? `Updated "${data.serviceName}".`
        : `Added "${data.serviceName}" to your tracked trials.`
    );
    closeTrialDialog();
    await loadTrials();
  } catch {
    trialSaveError.textContent = "Could not reach the server to save this trial.";
  } finally {
    trialsBusy = false;
    saveButton.disabled = false;
    saveButton.textContent = originalText;
  }
}

addTrialButton.addEventListener("click", () => openTrialDialog());
trialForm.querySelector('[data-action="cancel"]').addEventListener("click", closeTrialDialog);
trialForm.querySelector('[data-action="close"]').addEventListener("click", closeTrialDialog);
trialForm.querySelector('[data-action="review"]').addEventListener("click", handleReviewClick);
trialForm.querySelector('[data-action="back"]').addEventListener("click", () => showStep("form"));
trialForm.querySelector('[data-action="save"]').addEventListener("click", handleSaveClick);

trialDialog.addEventListener("close", () => {
  editingTrialId = null;
  pendingReviewValue = null;
  pendingImportSource = false;
  trialForm.reset();
  clearFieldErrors();
  clearFieldNotes();
  importContextEl.hidden = true;
  reviewDuplicateWarning.textContent = "";
  showStep("form");
});

trialForm.addEventListener("submit", (event) => {
  // The dialog form has no real submission target — Enter-to-submit is
  // redirected to whichever step is currently showing.
  event.preventDefault();
  if (reviewStepEl.hidden) {
    handleReviewClick();
  } else {
    handleSaveClick();
  }
});

// ---------- Import from text (AI-assisted extraction) ----------

function updateImportCount() {
  importTextCount.textContent = `${importTextArea.value.length} / 10,000 characters`;
}

function clearImportStatus() {
  importStatusEl.replaceChildren();
}

function showImportStatus(kind, ...children) {
  importStatusEl.replaceChildren(
    el("div", { className: `import-status-box import-status-${kind}` }, [
      icon(kind === "error" ? "alert" : "info"),
      el("div", {}, children),
    ])
  );
}

const PROVIDER_PRIVACY_TEXT = {
  ollama: "Extraction runs locally on this computer using Ollama — nothing is sent to a cloud AI provider.",
  anthropic: "This text is sent to our AI provider, Anthropic, to extract the trial details.",
};

// Honest, provider-specific expectation-setting while a request is in
// flight — no fabricated progress bar or percentage, since we have no way
// to know how far along a single non-streaming response actually is.
const PROVIDER_LOADING_NOTE = {
  ollama:
    "Running locally via Ollama. This can take up to a couple of minutes, especially the first request after Ollama has been idle — there's no progress percentage to show, the spinner just means it's still working.",
  anthropic: "Sending to Anthropic for extraction — this usually takes a few seconds.",
};

let providerMetaLoaded = false;
let currentProvider = "ollama";

async function loadProviderMeta() {
  if (providerMetaLoaded) return;
  try {
    const response = await fetch("/api/trials/import", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const meta = await response.json();
    const text = PROVIDER_PRIVACY_TEXT[meta.provider];
    if (text) importPrivacyDetail.textContent = text;
    if (PROVIDER_LOADING_NOTE[meta.provider]) currentProvider = meta.provider;
    providerMetaLoaded = true;
  } catch {
    // Keep the default (Ollama/local) copy already in the page if this fails.
  }
}

function openImportDialog() {
  importTextArea.value = "";
  updateImportCount();
  importErrorEl.textContent = "";
  clearImportStatus();
  importDialog.showModal();
  importTextArea.focus();
  loadProviderMeta();
}

function closeImportDialog() {
  importDialog.close();
}

function setExtracting(isExtracting) {
  importBusy = isExtracting;
  extractButton.disabled = isExtracting;
  importTextArea.disabled = isExtracting;
  extractSpinner.hidden = !isExtracting;
  extractSpinner.classList.toggle("is-spinning", isExtracting);
  extractLabel.textContent = isExtracting ? "Extracting…" : "Extract details";
}

async function handleExtractClick() {
  if (importBusy) return;

  const text = importTextArea.value;
  importErrorEl.textContent = "";
  clearImportStatus();

  if (!text.trim()) {
    importErrorEl.textContent = "Paste some trial confirmation text first.";
    importTextArea.focus();
    return;
  }
  if (text.length > 10_000) {
    importErrorEl.textContent = "Pasted text must be 10,000 characters or fewer.";
    return;
  }

  setExtracting(true);
  showImportStatus("info", el("p", { text: PROVIDER_LOADING_NOTE[currentProvider] }));

  try {
    const response = await fetch("/api/trials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();

    if (!response.ok) {
      const isNotConfigured = data.code === "AI_NOT_CONFIGURED";
      const manualButton = el("button", {
        type: "button",
        className: "btn btn-outline",
        text: "Switch to manual entry",
      });
      manualButton.addEventListener("click", () => {
        closeImportDialog();
        openTrialDialog();
      });
      showImportStatus(
        isNotConfigured ? "warning" : "error",
        el("p", { text: isNotConfigured ? "AI import is not configured yet." : "Couldn't extract details." }),
        el("p", { text: data.error ?? "Could not extract details from this text." }),
        manualButton
      );
      return;
    }

    if (data.multipleSubscriptions) {
      showImportStatus(
        "warning",
        el("p", { text: "This looks like more than one subscription. Paste one confirmation message at a time." })
      );
      return;
    }

    closeImportDialog();
    openImportPrefillDialog(data);
  } catch {
    showImportStatus("error", el("p", { text: "Could not reach the server to extract details." }));
  } finally {
    setExtracting(false);
  }
}

importTextArea.addEventListener("input", updateImportCount);
importTrialButton.addEventListener("click", openImportDialog);
document.querySelector('[data-action="import-cancel"]').addEventListener("click", closeImportDialog);
document.querySelector('[data-action="import-close"]').addEventListener("click", closeImportDialog);
extractButton.addEventListener("click", handleExtractClick);

importDialog.addEventListener("close", () => {
  importTextArea.value = "";
  updateImportCount();
  clearImportStatus();
  importErrorEl.textContent = "";
});

// ---------- Add to calendar (.ics export) ----------

function calendarReminderDefaults(trial) {
  const suggested = addDays(trial.trialEndDate, -trial.reminderLeadDays);
  return { date: dateKey(suggested), time: "09:00" };
}

// Reads the two separate date/time inputs as one Date. Constructed with
// the local Date constructor, so the browser resolves it to the correct
// UTC instant using its own timezone/DST rules — no manual offset math.
function readCalendarReminderDate() {
  const dateValue = calendarDateInput.value;
  const timeValue = calendarTimeInput.value;
  if (!dateValue || !timeValue) return null;

  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

// Re-checks the currently entered date/time against "now", updates the
// warning text and the download button's disabled state, and returns the
// resolved Date when it's valid and in the future (or null otherwise). A
// past reminder is explained and blocked here, never silently adjusted.
function validateCalendarReminder() {
  const reminderAt = readCalendarReminderDate();
  const inFuture = isReminderInFuture(reminderAt);

  calendarPastWarning.textContent = inFuture
    ? ""
    : "This reminder date and time has already passed. Choose a future date and time to download the reminder.";
  calendarDownloadButton.disabled = !inFuture;

  return inFuture ? reminderAt : null;
}

function openCalendarDialog(trial) {
  calendarTrial = trial;
  calendarServiceNameEl.textContent = trial.serviceName;
  calendarEndDateEl.textContent = `Recorded trial end date: ${formatCalendarDate(trial.trialEndDate)}`;

  const defaults = calendarReminderDefaults(trial);
  calendarDateInput.value = defaults.date;
  calendarTimeInput.value = defaults.time;

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  calendarTimezoneNote.textContent = `Times are in your browser's detected time zone: ${timeZone}.`;

  validateCalendarReminder();
  calendarDialog.showModal();
}

function closeCalendarDialog() {
  calendarDialog.close();
}

function handleCalendarDownload() {
  if (!calendarTrial) return;

  // Re-validate live, in case time has passed since the dialog opened —
  // never proceed on a stale "was valid a minute ago" check.
  const reminderAt = validateCalendarReminder();
  if (!reminderAt) return;

  const ics = buildTrialReminderICS(calendarTrial, reminderAt, new Date());
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const filename = `${sanitizeFilename(calendarTrial.serviceName)}-trial-reminder.ics`;

  const link = el("a", { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  showBanner(
    "success",
    `Downloaded ${filename}. Import it into your calendar app, then check that event's notification settings there.`
  );
  closeCalendarDialog();
}

document.querySelector('[data-action="calendar-close"]').addEventListener("click", closeCalendarDialog);
document.querySelector('[data-action="calendar-cancel"]').addEventListener("click", closeCalendarDialog);
calendarDownloadButton.addEventListener("click", handleCalendarDownload);
calendarDateInput.addEventListener("input", validateCalendarReminder);
calendarTimeInput.addEventListener("input", validateCalendarReminder);

calendarDialog.addEventListener("close", () => {
  calendarTrial = null;
  calendarPastWarning.textContent = "";
});

// Trial status (days remaining, "ends today", etc.) depends on the
// viewer's local calendar date, so re-render once it rolls over while the
// dashboard is left open.
function checkDateRollover() {
  const todayKey = new Date().toDateString();
  if (todayKey !== lastDateKey) {
    lastDateKey = todayKey;
    renderTrials();
  }
}

lastDateKey = new Date().toDateString();
setInterval(checkDateRollover, 60_000);

// ---------- Budget conversation ----------

function renderBudgetSummary(summary) {
  budgetSummaryBudget.textContent =
    summary.budget.amountCents === null ? "Not set" : formatUsd(summary.budget.amountCents);
  budgetSummaryTracked.textContent = formatUsd(summary.potentialRenewals.totalMonthlyEquivalentCents);

  budgetSummaryDiff.classList.remove("is-over", "is-under");
  if (summary.comparison.status === "unset") {
    budgetSummaryDiff.textContent = "—";
    budgetSummaryDiffLabel.textContent = "Difference";
  } else if (summary.comparison.status === "over") {
    budgetSummaryDiff.textContent = formatSignedUsd(summary.comparison.diffCents);
    budgetSummaryDiff.classList.add("is-over");
    budgetSummaryDiffLabel.textContent = "Over budget";
  } else if (summary.comparison.status === "under") {
    budgetSummaryDiff.textContent = formatUsd(Math.abs(summary.comparison.diffCents));
    budgetSummaryDiff.classList.add("is-under");
    budgetSummaryDiffLabel.textContent = "Under budget";
  } else {
    budgetSummaryDiff.textContent = "$0.00";
    budgetSummaryDiffLabel.textContent = "At budget";
  }

  budgetSandboxNoteEl.textContent = sandboxNote(summary.paypalSandboxes ?? summary.paypalSandbox);
}

function renderScenarioNote() {
  if (scenarioRecords.length === 0) {
    budgetScenarioNoteEl.hidden = true;
    budgetScenarioNoteEl.replaceChildren();
    return;
  }

  const names = scenarioRecords.map((record) => record.serviceName).join(", ");
  const resetButton = el("button", {
    type: "button",
    className: "btn btn-outline btn-small",
    text: "Reset scenario",
  });
  resetButton.addEventListener("click", resetScenario);

  budgetScenarioNoteEl.replaceChildren(
    el("span", { text: `Currently excluding from your tracked total: ${names}. ` }),
    resetButton
  );
  budgetScenarioNoteEl.hidden = false;
}

function updateScenarioFromSummary(summary) {
  scenarioRecords = summary.potentialRenewals.excludedItems ?? [];
  scenarioExcludeIds = scenarioRecords.map((record) => record.id);
  renderScenarioNote();
}

function resetScenario() {
  scenarioExcludeIds = [];
  scenarioRecords = [];
  renderScenarioNote();
  loadBudgetSummary();
}

async function loadBudget() {
  try {
    const response = await fetch("/api/budget", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (response.ok && data.amountCents !== null) {
      budgetAmountInput.value = formatCentsAsAmount(data.amountCents);
    }
  } catch {
    // Leave the input blank; the summary tile will still say "Not set".
  }
}

async function loadBudgetSummary() {
  try {
    const response = await fetch("/api/budget/summary", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) {
      budgetSandboxNoteEl.textContent = data.error ?? "Could not load your budget summary.";
      return;
    }
    renderBudgetSummary(data);
  } catch {
    budgetSandboxNoteEl.textContent = "Could not reach the server to load your budget summary.";
  }
}

function loadBudgetSection() {
  return Promise.all([loadBudget(), loadBudgetSummary()]);
}

function setBudgetBusy(isBusy) {
  budgetBusy = isBusy;
  budgetSaveButton.disabled = isBusy;
  budgetClearButton.disabled = isBusy;
}

async function handleSaveBudget() {
  if (budgetBusy) return;
  budgetSaveError.textContent = "";
  const raw = budgetAmountInput.value.trim();

  setBudgetBusy(true);
  try {
    const response = await fetch("/api/budget", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ amount: raw === "" ? null : raw }),
    });
    const data = await response.json();

    if (!response.ok) {
      budgetSaveError.textContent = data.fieldErrors?.amount ?? data.error ?? "Could not save your budget.";
      return;
    }

    showBanner(
      "success",
      data.amountCents === null ? "Budget cleared." : `Budget set to ${formatUsd(data.amountCents)}/mo.`
    );
    await loadBudgetSummary();
  } catch {
    budgetSaveError.textContent = "Could not reach the server to save your budget.";
  } finally {
    setBudgetBusy(false);
  }
}

async function handleClearBudget() {
  if (budgetBusy) return;
  budgetAmountInput.value = "";
  await handleSaveBudget();
}

function setAskBusy(isBusy) {
  askBusy = isBusy;
  budgetAskButton.disabled = isBusy;
  budgetAskButton.textContent = isBusy ? "Asking…" : "Ask";
  budgetAskInput.disabled = isBusy;
  for (const button of budgetSuggestedQuestionsEl.querySelectorAll("button")) {
    button.disabled = isBusy;
  }
}

function recordRow(record, isExcluded) {
  return el("li", { className: isExcluded ? "is-excluded" : "" }, [el("span", { text: record.label })]);
}

// Renders exactly one answer card. `source` labels suggested-button
// answers as "calculated summary" (no AI involved) versus free-text
// answers as "AI-interpreted" — the AI only ever picked the intent/records
// here; every number was still filled in from server-calculated templates.
function renderAnswerCard({ kind, source, headline, bodyLines, includedRecords = [], excludedRecords = [], clarification = null }) {
  const children = [];

  if (source) {
    children.push(
      el("span", { className: `budget-answer-source is-${source}` }, [
        el("span", { text: source === "calculated" ? "Calculated summary" : "AI-interpreted, calculated result" }),
      ])
    );
  }

  children.push(el("h3", { className: "budget-answer-headline", text: headline }));
  children.push(el("div", { className: "budget-answer-body" }, bodyLines.map((line) => el("p", { text: line }))));

  if (includedRecords.length > 0 || excludedRecords.length > 0) {
    children.push(
      el("div", { className: "budget-answer-records" }, [
        el("p", { className: "budget-answer-records-title", text: "Records included in this calculation" }),
        el("ul", {}, [
          ...includedRecords.map((record) => recordRow(record, false)),
          ...excludedRecords.map((record) => recordRow(record, true)),
        ]),
      ])
    );
  }

  if (clarification) {
    children.push(
      el(
        "div",
        { className: "budget-clarification-options" },
        clarification.candidates.map((candidate) => {
          const button = el("button", { type: "button", className: "btn btn-outline btn-small" }, [
            el("span", {
              text: `${candidate.serviceName} — ends ${candidate.trialEndDate}, ${formatUsd(candidate.renewalPriceCents)}/mo`,
            }),
          ]);
          button.addEventListener("click", () => handleClarificationChoice(candidate.id));
          return button;
        })
      )
    );
  }

  budgetAnswerEl.replaceChildren(el("div", { className: `budget-answer-card${kind ? ` is-${kind}` : ""}` }, children));
}

async function runQuery(intent, { excludeTrialIds = [] } = {}) {
  if (askBusy) return;
  setAskBusy(true);

  try {
    const response = await fetch("/api/budget/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ intent, excludeTrialIds }),
    });
    const data = await response.json();

    if (!response.ok) {
      renderAnswerCard({
        kind: "rejected",
        headline: "Could not calculate that",
        bodyLines: [data.error ?? "Something went wrong."],
      });
      return;
    }

    renderBudgetSummary(data.summary);
    updateScenarioFromSummary(data.summary);
    renderAnswerCard({
      source: "calculated",
      headline: data.answer.headline,
      bodyLines: data.answer.body,
      includedRecords: data.answer.includedRecords,
      excludedRecords: data.answer.excludedRecords,
    });
  } catch {
    renderAnswerCard({
      kind: "rejected",
      headline: "Could not reach the server",
      bodyLines: ["Could not reach the server to calculate this."],
    });
  } finally {
    setAskBusy(false);
  }
}

function handleClarificationChoice(candidateId) {
  runQuery("hypothetical_exclusion", { excludeTrialIds: [...scenarioExcludeIds, candidateId] });
}

async function handleAskSubmit(rawText) {
  if (askBusy) return;
  const text = rawText.trim();
  if (!text) return;

  if (text.length > 500) {
    renderAnswerCard({
      kind: "rejected",
      headline: "Question too long",
      bodyLines: ["Questions must be 500 characters or fewer."],
    });
    return;
  }

  setAskBusy(true);
  budgetAnswerEl.replaceChildren(
    el("p", {
      className: "panel-note",
      text: "Thinking locally via Ollama… this can take up to a couple of minutes, especially the first question after Ollama has been idle.",
    })
  );

  try {
    const response = await fetch("/api/budget/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text, excludeTrialIds: scenarioExcludeIds }),
    });
    const data = await response.json();

    if (!response.ok) {
      renderAnswerCard({
        kind: "rejected",
        headline: "Could not answer that",
        bodyLines: [data.error ?? "Something went wrong."],
      });
      return;
    }

    if (data.type === "clarification") {
      renderAnswerCard({
        kind: "clarification",
        source: "ai-interpreted",
        headline: "Which one do you mean?",
        bodyLines: data.ambiguous.map((entry) => `More than one tracked record is named "${entry.name}":`),
        clarification: data.ambiguous[0],
      });
      return;
    }

    if (data.type === "rejected") {
      renderAnswerCard({
        kind: "rejected",
        source: "ai-interpreted",
        headline: data.answer.headline,
        bodyLines: data.answer.body,
      });
      return;
    }

    if (data.summary) {
      renderBudgetSummary(data.summary);
      updateScenarioFromSummary(data.summary);
    }
    renderAnswerCard({
      source: "ai-interpreted",
      headline: data.answer.headline,
      bodyLines: data.answer.body,
      includedRecords: data.answer.includedRecords,
      excludedRecords: data.answer.excludedRecords,
    });
  } catch {
    renderAnswerCard({
      kind: "rejected",
      headline: "Could not reach the server",
      bodyLines: ["Could not reach the server to ask this question."],
    });
  } finally {
    setAskBusy(false);
  }
}

budgetSaveButton.addEventListener("click", handleSaveBudget);
budgetClearButton.addEventListener("click", handleClearBudget);

for (const button of budgetSuggestedQuestionsEl.querySelectorAll("button[data-intent]")) {
  button.addEventListener("click", () => runQuery(button.dataset.intent, { excludeTrialIds: scenarioExcludeIds }));
}
for (const button of budgetSuggestedQuestionsEl.querySelectorAll("button[data-ask-example]")) {
  button.addEventListener("click", () => {
    budgetAskInput.value = button.dataset.askExample;
    handleAskSubmit(button.dataset.askExample);
  });
}

budgetAskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAskSubmit(budgetAskInput.value);
});

refreshButton.addEventListener("click", load);

load();
loadTrials();
loadBudgetSection();
