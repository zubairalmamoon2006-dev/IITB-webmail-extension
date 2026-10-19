// Picks which mails the chat sends to Gemini in full. Same idea as the Course
// Recommender: understand the question (dates, intent), score mails two ways
// (BM25 keywords and MiniLM meaning), merge the two rankings with RRF, then add
// small boosts (date match, sender type, recency, unread).
// Pure functions, so they also run in Node for tests.

const RET_RRF_K = 60;
const RET_BM25_K1 = 1.2;
const RET_BM25_B = 0.75;
const RET_EXPANSION_WEIGHT = 0.4;
const RET_BODY_CHARS = 3000;

const RET_STOPWORDS = new Set((
  "a an and any are as at be been being but by can could did do does doing done for from get got " +
  "had has have having he her here hers him his how i if in into is it its just me mine more most my " +
  "no not now of on or our ours out over please same she should show so some such tell than that the " +
  "their theirs them then there these they this those through to too up us very was we were what when " +
  "where which while who whom whose why will with would you your yours anything something everything " +
  "mail mails email emails inbox message messages give list find let know about all also coming upcoming " +
  "happening there's what's whats im i'm ive " +
  // time words are handled by the date logic, not as keywords
  "week weeks day days today tonight tomorrow yesterday month months next last past previous following current soon"
).split(" "));

const RET_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const RET_WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const RET_MONTH_PATTERN = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const RET_WEEKDAY_PATTERN = "(sun|mon|tue|wed|thu|fri|sat)[a-z]*day";

// What the student is asking about, and words that usually appear in such mails.
const RET_INTENTS = [
  {
    key: "deadline",
    match: /\b(deadlines?|due|last date|urgent|closes?|closing|expir\w*)\b/,
    expand: ["deadline", "due", "date", "close", "closing", "submit", "submission", "before", "extended", "extension", "reminder", "latest"],
    future: true,
  },
  {
    key: "exam",
    match: /\b(quiz\w*|exams?|midsem|endsem|tests?|viva|submissions?|assignments?|lab reports?|evaluations?)\b/,
    expand: ["quiz", "exam", "midsem", "endsem", "test", "viva", "assignment", "submission", "evaluation", "syllabus", "lab", "report", "tutorial", "marks"],
    future: true,
  },
  {
    key: "action",
    match: /\b(reply|respond|asked me|ask me|do something|action|to-?do|need to|have to|rsvp|confirm)\b/,
    expand: ["reply", "respond", "confirm", "rsvp", "fill", "form", "register", "registration", "kindly", "request", "required", "mandatory", "submit", "asap", "let", "know"],
  },
  {
    key: "faculty",
    match: /\b(profs?|professors?|faculty|instructors?|tas|ta|teaching assistants?)\b/,
    sender: true,
  },
  {
    key: "event",
    match: /\b(events?|talks?|seminars?|workshops?|webinars?|sessions?|lectures?|fests?|competitions?|screenings?|meetups?|orientations?)\b/,
    expand: ["event", "talk", "seminar", "workshop", "webinar", "session", "lecture", "fest", "competition", "venue", "screening", "orientation", "invite", "join"],
    future: true,
  },
  {
    key: "career",
    match: /\b(intern\w*|jobs?|placements?|openings?|recruit\w*|hiring|careers?|applications?|apply|ppts?)\b/,
    expand: ["internship", "intern", "job", "placement", "recruitment", "hiring", "opening", "application", "apply", "ppt", "role", "stipend", "resume", "cv", "shortlist", "interview"],
  },
];

function retStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function retAddDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function retStem(word) {
  if (word.length > 4 && word.endsWith("zzes")) return word.slice(0, -3); // quizzes -> quiz
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function retTokenize(text) {
  const lower = String(text || "").toLowerCase();
  const tokens = [];
  // Course codes: "MM 305", "mm305", "CS-213" all become "mm305" / "cs213".
  for (const m of lower.matchAll(/\b([a-z]{2,4})[\s-]?(\d{3,4})\b/g)) tokens.push(m[1] + m[2]);
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (!raw || RET_STOPWORDS.has(raw)) continue;
    if (raw.length < 2) continue;
    tokens.push(retStem(raw));
  }
  return tokens;
}

function retIntents(question) {
  const q = String(question || "").toLowerCase();
  return RET_INTENTS.filter((intent) => intent.match.test(q));
}

function retWeekRange(today, offsetWeeks) {
  const day = today.getDay(); // 0 = Sunday
  const monday = retAddDays(today, -((day + 6) % 7) + offsetWeeks * 7);
  return { start: monday, end: retAddDays(monday, 6) };
}

// Works out the dates a question is about.
// mode "received": mails received in the range (yesterday, last 3 days).
// mode "mentioned": mails that mention a date in the range (deadlines next week).
// mode "either": both count (today, this week).
function retParseTime(question, now = new Date()) {
  const q = String(question || "").toLowerCase();
  const today = retStartOfDay(now);
  let m;

  if (/\byesterday\b/.test(q)) return { start: retAddDays(today, -1), end: retAddDays(today, -1), mode: "received" };
  if ((m = q.match(/\b(?:last|past|previous)\s+(\d{1,2})\s+days?\b/))) {
    return { start: retAddDays(today, -Number(m[1])), end: today, mode: "received" };
  }
  if ((m = q.match(/\b(?:next|coming|upcoming|following)\s+(\d{1,2})\s+days?\b/)) || (m = q.match(/\bin\s+(\d{1,2})\s+days\b/))) {
    return { start: today, end: retAddDays(today, Number(m[1])), mode: "mentioned" };
  }
  if (/\blast week\b/.test(q)) return { ...retWeekRange(today, -1), mode: "received" };
  if (/\bnext week\b/.test(q)) return { ...retWeekRange(today, 1), mode: "mentioned" };
  if (/\b(this|current)\s+week\b/.test(q)) return { ...retWeekRange(today, 0), mode: "either" };
  if (/\bday after tomorrow\b/.test(q)) return { start: retAddDays(today, 2), end: retAddDays(today, 2), mode: "mentioned" };
  if (/\btomorrow\b/.test(q)) return { start: retAddDays(today, 1), end: retAddDays(today, 1), mode: "mentioned" };
  if (/\b(today|tonight)\b/.test(q)) return { start: today, end: today, mode: "either" };
  if (/\bthis month\b/.test(q)) {
    return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: new Date(today.getFullYear(), today.getMonth() + 1, 0), mode: "either" };
  }
  if ((m = q.match(new RegExp(`\\b${RET_WEEKDAY_PATTERN}\\b`)))) {
    const target = RET_WEEKDAYS[m[1]];
    const day = retAddDays(today, (target - today.getDay() + 7) % 7);
    return { start: day, end: day, mode: "mentioned" };
  }
  if (retIntents(q).some((intent) => intent.future) || /\b(coming up|upcoming|soon|pending)\b/.test(q)) {
    return { start: today, end: retAddDays(today, 21), mode: "mentioned", soft: true };
  }
  return null;
}

function retMakeDate(year, month, day) {
  const d = new Date(year, month, day);
  return d.getMonth() === month && d.getDate() === day ? d : null;
}

// Dates a mail talks about ("17 Oct", "Oct 17th, 2026", "17/10/26", "tomorrow", "Friday").
function retMentionedDates(text, receivedAt) {
  const received = retStartOfDay(receivedAt ? new Date(receivedAt) : new Date());
  const t = String(text || "").toLowerCase().slice(0, 5000);
  const found = [];
  const guessYear = (month, day, explicitYear) => {
    if (explicitYear) {
      const y = Number(explicitYear);
      return y < 100 ? 2000 + y : y;
    }
    const sameYear = new Date(received.getFullYear(), month, day);
    // "5 Jan" in a December mail means next January.
    return sameYear < retAddDays(received, -60) ? received.getFullYear() + 1 : received.getFullYear();
  };
  const push = (d) => {
    if (d && !Number.isNaN(d.getTime())) found.push(retStartOfDay(d));
  };

  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(?:of\\s+)?${RET_MONTH_PATTERN},?(?:[\\s-]+(\\d{4}))?`, "g"))) {
    const month = RET_MONTHS[m[2]];
    push(retMakeDate(guessYear(month, Number(m[1]), m[3]), month, Number(m[1])));
  }
  for (const m of t.matchAll(new RegExp(`\\b${RET_MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"))) {
    const month = RET_MONTHS[m[1]];
    push(retMakeDate(guessYear(month, Number(m[2]), m[3]), month, Number(m[2])));
  }
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const month = Number(m[2]) - 1;
    if (month >= 0 && month < 12) push(retMakeDate(guessYear(month, Number(m[1]), m[3]), month, Number(m[1])));
  }
  if (/\b(today|tonight|this evening)\b/.test(t)) push(received);
  if (/\btomorrow\b/.test(t)) push(retAddDays(received, 1));
  for (const m of t.matchAll(new RegExp(`\\b(?:this|next|on|coming|by)\\s+${RET_WEEKDAY_PATTERN}\\b`, "g"))) {
    const target = RET_WEEKDAYS[m[1]];
    push(retAddDays(received, ((target - received.getDay() + 7) % 7) || 7));
  }
  return found;
}

function retSenderKind(email) {
  const name = String(email.senderName || "").trim();
  const address = String(email.senderEmail || "").toLowerCase();
  const local = address.split("@")[0] || "";
  const domain = address.split("@")[1] || "";
  const subject = String(email.subject || "");

  if (/^(prof|dr)\.?\s/i.test(name) || /\bprofessor\b/i.test(name)) return "faculty";
  if (/(^|[^A-Za-z])TAs?([^A-Za-z]|$)|teaching assistant/.test(`${subject} ${name}`)) return "ta";
  if (/^\d{2}[a-z]\d{4}$|^\d{8,9}$/.test(local)) return "student";
  if (/\b(club|team|society|cell|council|committee|desk|office|board|fest|newsletter)\b/i.test(name)) return "office";
  if (/(office|dean|acad|registrar|hostel|gymkhana|placement|noreply|no-reply|admin|helpdesk|secretary|council|cell|club|team|info|notice|events?)/.test(local)) {
    return "office";
  }
  if (domain.endsWith("iitb.ac.in") && /^[a-z][a-z.]+$/.test(local)) return "faculty";
  return "other";
}

function retInRange(date, range) {
  return date >= range.start && date <= range.end;
}

function retCosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function retDocTokens(email) {
  const subject = retTokenize(email.subject);
  const sender = retTokenize(`${email.senderName || ""} ${email.senderEmail || ""}`);
  const body = retTokenize(String(email.body || email.excerpt || email.snippet || "").slice(0, RET_BODY_CHARS));
  return [...subject, ...subject, ...subject, ...sender, ...sender, ...body];
}

function retBm25Scores(docs, queryWeights) {
  const n = docs.length;
  const df = new Map();
  let totalLength = 0;
  const termFreqs = docs.map((tokens) => {
    totalLength += tokens.length;
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    return tf;
  });
  const avgLength = totalLength / Math.max(n, 1) || 1;

  return termFreqs.map((tf, i) => {
    const length = docs[i].length;
    let score = 0;
    for (const [term, weight] of queryWeights) {
      const freq = tf.get(term);
      if (!freq) continue;
      const docFreq = df.get(term) || 0;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      score += weight * idf * ((freq * (RET_BM25_K1 + 1)) / (freq + RET_BM25_K1 * (1 - RET_BM25_B + (RET_BM25_B * length) / avgLength)));
    }
    return score;
  });
}

function retRankPositions(scores) {
  // Returns rank (1-based) per index for scores > 0, else null.
  const order = scores
    .map((score, index) => ({ score, index }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const ranks = new Array(scores.length).fill(null);
  order.forEach((item, position) => {
    ranks[item.index] = position + 1;
  });
  return ranks;
}

// A mail that revises an earlier announcement: "Quiz 2 rescheduled to 15 Oct",
// "session postponed", "event cancelled". These must beat the mail they replace.
const RET_UPDATE_PATTERN = /\b(reschedul\w*|postpon\w*|prepon\w*|cancel\w*|corrigendum|revis\w*|stands? changed|changed to|new date|withdraw\w*)\b/i;

// What a mail is "about": its course codes ("ae308") plus its subject with
// re:/fw: stripped, so an update can be matched to the mail it updates.
function retTopicKeys(email) {
  const subject = String(email.subject || "");
  const body = String(email.body || email.excerpt || email.snippet || "").slice(0, 3000);
  const keys = new Set();
  for (const m of `${subject}\n${body}`.toLowerCase().matchAll(/\b([a-z]{2,4})[\s-]?(\d{3,4})\b/g)) {
    keys.add(m[1] + m[2]);
  }
  const bare = subject.toLowerCase()
    .replace(/^\s*(?:re|fwd?|fw)\s*[:\-]\s*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (bare.split(" ").length >= 2) keys.add(`s:${bare}`);
  return keys;
}

// Main entry: returns [{ email, score, why }] best first. Sensitive mails are left out.
function rankMailsForQuestion(emails, question, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const windowDays = options.windowDays || 15;
  const queryVector = options.queryVector || null;
  const today = retStartOfDay(now);
  const time = retParseTime(question, now);
  const intents = retIntents(question);
  const wantsFaculty = intents.some((intent) => intent.sender);
  const wantsFuture = intents.some((intent) => intent.future);

  let pool = (emails || []).filter((email) => !email.sensitive);

  // "yesterday", "last 3 days": only mails received then (if there are any).
  if (time && time.mode === "received") {
    const inRange = pool.filter((email) => retInRange(retStartOfDay(email.receivedAt), time));
    if (inRange.length) pool = inRange;
  }
  if (!pool.length) return [];

  const queryWeights = new Map();
  for (const token of retTokenize(question)) queryWeights.set(token, 1);
  for (const intent of intents) {
    for (const word of intent.expand || []) {
      const token = retStem(word);
      if (!queryWeights.has(token)) queryWeights.set(token, RET_EXPANSION_WEIGHT);
    }
  }

  const bm25 = retBm25Scores(pool.map(retDocTokens), queryWeights);
  const vectorScores = pool.map((email) => (queryVector && email.vec ? retCosine(queryVector, email.vec) : 0));
  const bm25Ranks = retRankPositions(bm25);
  const vectorRanks = retRankPositions(vectorScores);

  // "Latest word wins": for each topic (course code or subject thread), the
  // newest mail that revises an earlier announcement gets a boost, so a
  // reschedule/cancellation beats the stale announcement it replaces.
  const updateFlags = pool.map((email) =>
    RET_UPDATE_PATTERN.test(
      `${email.subject || ""}\n${String(email.body || email.excerpt || email.snippet || "").slice(0, 3000)}`
    )
  );
  const updateBoosted = new Set();
  {
    const newestByKey = new Map();
    pool.forEach((email, i) => {
      if (!updateFlags[i]) return;
      const when = new Date(email.receivedAt).getTime();
      for (const key of retTopicKeys(email)) {
        const prev = newestByKey.get(key);
        if (!prev || when > prev.when) newestByKey.set(key, { index: i, when });
      }
    });
    newestByKey.forEach((entry) => updateBoosted.add(entry.index));
  }

  return pool
    .map((email, i) => {
      const why = [];
      let score = 0;
      if (bm25Ranks[i]) {
        score += 1 / (RET_RRF_K + bm25Ranks[i]);
        why.push(`kw#${bm25Ranks[i]}`);
      }
      if (vectorRanks[i]) {
        score += 1 / (RET_RRF_K + vectorRanks[i]);
        why.push(`vec#${vectorRanks[i]}`);
      }

      const received = retStartOfDay(email.receivedAt);
      const mentioned = time || wantsFuture
        ? retMentionedDates(`${email.subject || ""}\n${email.body || email.excerpt || email.snippet || ""}`, email.receivedAt)
        : [];

      if (time) {
        const receivedHit = time.mode !== "mentioned" && retInRange(received, time);
        const mentionedHit = time.mode !== "received" && mentioned.some((d) => retInRange(d, time));
        if (receivedHit || mentionedHit) {
          score += time.soft ? 0.012 : 0.02;
          why.push(mentionedHit ? "date" : "received");
        }
      }
      if (updateBoosted.has(i)) {
        // The newest word on this topic — it can reschedule, move to the past
        // or cancel what an older mail announced, so it must outrank that mail
        // and must never be pushed down for "only mentioning past dates".
        score += 0.012;
        why.push("update");
      } else if (wantsFuture && mentioned.length && mentioned.every((d) => d < today)) {
        score -= 0.006; // only talks about dates that have passed
        why.push("past");
      }

      if (wantsFaculty) {
        const kind = retSenderKind(email);
        if (kind === "faculty") score += 0.02;
        if (kind === "ta") score += 0.015;
        if (kind === "faculty" || kind === "ta") why.push(kind);
      }

      const ageDays = Math.max(0, (now - new Date(email.receivedAt)) / 86400000);
      score += 0.006 * Math.max(0, 1 - ageDays / windowDays);
      if (!email.isRead) score += 0.002;

      return { email, score, why: why.join(" ") };
    })
    .sort((a, b) => b.score - a.score);
}

function describeTimeRange(range) {
  if (!range) return "";
  const fmt = (d) => d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  const span = range.start.getTime() === range.end.getTime() ? fmt(range.start) : `${fmt(range.start)} to ${fmt(range.end)}`;
  if (range.mode === "received") return `The question is about mails received ${span}.`;
  if (range.mode === "mentioned") return `The question is about things happening or due ${span}.`;
  return `The question is about ${span} (mails received then, or about things happening then).`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    rankMailsForQuestion,
    retParseTime,
    retMentionedDates,
    retSenderKind,
    retTokenize,
    retIntents,
    describeTimeRange,
  };
}
