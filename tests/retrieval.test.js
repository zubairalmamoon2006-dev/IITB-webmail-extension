// Run: node tests/retrieval.test.js
// Keyword + date side of the chat search (no vectors here; those are checked in the browser test).
const assert = require("assert");
const path = require("path");
const R = require(path.join(__dirname, "..", "extension", "retrieval.js"));

const NOW = new Date(2026, 9, 14, 18, 0); // Wed 14 Oct 2026, 6 PM
const at = (daysAgo, hour = 10) => new Date(2026, 9, 14 - daysAgo, hour).toISOString();
let uid = 1000;
const mail = (daysAgo, senderName, senderEmail, subject, body, extra = {}) =>
  ({ uid: uid++, receivedAt: at(daysAgo), senderName, senderEmail, subject, body, isRead: true, ...extra });

const inbox = [
  mail(0, "Prof Sharma", "sharma@iitb.ac.in", "MM 305 Quiz 2 on Friday", "Dear students, Quiz 2 will be held on 16 Oct at 8:30 AM in LH 101. Syllabus: lectures 8-14.", { isRead: false }),
  mail(1, "Placement Cell", "placement@iitb.ac.in", "Applications open: Interview Coordinator", "Applications for Interview Coordinator close on 16 Oct, 11:59 PM. Fill the form on the portal."),
  mail(2, "Course TA", "24d0123@iitb.ac.in", "[DH 302] TA: Milestone 2 report due 20 Oct", "Milestone 2 report is due on 20 Oct. Submit on Moodle. Late submissions lose marks."),
  mail(3, "Hostel 7", "h7office@iitb.ac.in", "Hostel 7 water supply notice", "Water supply will be off on Sunday from 9 AM to 1 PM for maintenance."),
  mail(1, "Film Club", "filmclub@iitb.ac.in", "Screening tonight: Inception", "Join us for a screening tonight at 8 PM in LH 102. Free popcorn."),
  mail(0, "Astronomy Club", "krittika@iitb.ac.in", "Astromania talk on Thursday", "A talk on black holes by Dr Rao on 15 Oct at 7 PM in LA 001. All are welcome."),
  mail(4, "Goldman Sachs Campus", "campus@gs.com", "Summer internship 2027: applications open", "Goldman Sachs invites applications for summer internship roles. Apply by 25 Oct. Stipend competitive."),
  mail(5, "Dean Academic", "dean.acad@iitb.ac.in", "Midsem exam timetable", "The midsem exams begin on 19 Oct. The timetable is attached. Exams in the evening slot."),
  mail(6, "Gymkhana", "gymkhana@iitb.ac.in", "Inter-hostel cricket results", "Hostel 4 won the inter-hostel cricket final. Congratulations to all players."),
  mail(2, "Rahul", "24b1234@iitb.ac.in", "Can you share the EE 229 notes?", "Hey, could you please reply with the EE 229 notes from last week? Need them before the quiz."),
  mail(7, "Prof Iyer", "iyer@ee.iitb.ac.in", "EE 229 assignment 3 posted", "Assignment 3 is posted on Moodle. Due on 10 Oct."),
  mail(3, "Events Desk", "desk@example.com", "Webinar seat confirmation", "Please confirm your webinar seat by replying before Friday."),
  mail(9, "Newsletter", "news@insightiitb.org", "Insight weekly digest", "This week in campus news: elections, fests and more."),
  mail(12, "Prof Rao", "rao@ae.iitb.ac.in", "AE 308 Quiz 2 on 21 Oct", "Control Theory Quiz 2 will be held on 21 Oct, 4:30 PM in LH 102. Syllabus: units 1-4."),
  mail(2, "Prof Rao", "rao@ae.iitb.ac.in", "AE 308 Quiz 2 rescheduled", "Please note that Quiz 2 stands rescheduled to 13 Oct, 4:30 PM in LH 102.", { isRead: false }),
  mail(0, "Sensitive", "otp@x.com", "Sensitive mail hidden", "", { sensitive: "otp" }),
];

const top = (q, n = 5) => R.rankMailsForQuestion(inbox, q, { now: NOW }).slice(0, n).map((r) => r.email.subject);
const has = (list, needle) => list.some((s) => s.includes(needle));
if (process.env.SHOW) {
  for (const q of process.env.SHOW.split("|")) {
    console.log(`\n${q}`);
    R.rankMailsForQuestion(inbox, q, { now: NOW }).slice(0, 6)
      .forEach((r) => console.log(r.score.toFixed(4), r.why.padEnd(24), r.email.subject));
  }
  process.exit(0);
}
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures++; console.log(`FAIL ${name}: ${err.message}`); }
};

check("deadlines in next 7 days", () => {
  const t = top("Any deadlines in the next 7 days?");
  for (const s of ["Interview Coordinator", "Milestone 2", "MM 305 Quiz"]) assert.ok(has(t, s), `${s} missing from ${JSON.stringify(t)}`);
  assert.ok(!has(t.slice(0, 3), "assignment 3"), "past deadline ranked too high");
});
check("quizzes and exams", () => {
  const t = top("Any quizzes, exams or submissions coming up?");
  for (const s of ["MM 305 Quiz", "Midsem", "Milestone 2"]) assert.ok(has(t, s), `${s} missing from ${JSON.stringify(t)}`);
});
check("rescheduled quiz beats the stale announcement", () => {
  const q = "Any quizzes, exams or submissions coming up?";
  const ranked = R.rankMailsForQuestion(inbox, q, { now: NOW }).map((r) => r.email.subject);
  const up = ranked.findIndex((s) => s.includes("rescheduled"));
  const stale = ranked.findIndex((s) => s.includes("AE 308 Quiz 2 on 21 Oct"));
  assert.ok(up >= 0, "update mail not ranked at all");
  assert.ok(stale >= 0, "original announcement not ranked at all");
  assert.ok(up < stale, `update (#${up + 1}) should outrank stale announcement (#${stale + 1})`);
});
check("update mail is never pushed down as past", () => {
  const q = "Any quizzes, exams or submissions coming up?";
  const ranked = R.rankMailsForQuestion(inbox, q, { now: NOW });
  const upd = ranked.find((r) => r.email.subject.includes("rescheduled"));
  assert.ok(upd, "update mail not ranked");
  assert.ok(!upd.why.includes("past"), `update mail penalised as past: "${upd.why}"`);
  assert.ok(upd.why.includes("update"), `update boost missing: "${upd.why}"`);
});
check("asked to reply", () => {
  const t = top("Did anyone ask me to reply or do something?");
  for (const s of ["EE 229 notes", "Webinar seat"]) assert.ok(has(t, s), `${s} missing from ${JSON.stringify(t)}`);
});
check("professors or TAs", () => {
  const t = top("Any mails from professors or TAs?");
  for (const s of ["MM 305 Quiz", "Milestone 2", "assignment 3"]) assert.ok(has(t, s), `${s} missing from ${JSON.stringify(t)}`);
});
check("events this week", () => {
  const t = top("What events or talks are happening this week?");
  for (const s of ["Astromania", "Screening"]) assert.ok(has(t, s), `${s} missing from ${JSON.stringify(t)}`);
});
check("internships", () => {
  const t = top("Any internship, job or application openings?", 3);
  for (const s of ["Summer internship", "Interview Coordinator"]) assert.ok(has(t, s), `${s} missing from ${JSON.stringify(t)}`);
});
check("course code search", () => {
  assert.ok(top("anything about mm305?", 1)[0].includes("MM 305"));
  assert.ok(top("EE-229", 2).every((s) => s.includes("EE 229")));
});
check("yesterday filters by received date", () => {
  const ranked = R.rankMailsForQuestion(inbox, "what came yesterday?", { now: NOW });
  assert.ok(ranked.length > 0 && ranked.every((r) => new Date(r.email.receivedAt).getDate() === 13));
});
check("sensitive mails never ranked", () => {
  assert.ok(!R.rankMailsForQuestion(inbox, "otp", { now: NOW }).some((r) => r.email.sensitive));
});
check("date parsing", () => {
  const d = R.retMentionedDates("Due 20 Oct. Quiz on Oct 16th, 2026. Form by 17/10/26. See you tomorrow.", at(0));
  const days = d.map((x) => `${x.getMonth() + 1}/${x.getDate()}`);
  for (const s of ["10/20", "10/16", "10/17", "10/15"]) assert.ok(days.includes(s), `${s} not in ${days}`);
  assert.ok(!R.retMentionedDates("lectures 8-14 at 8:30 AM", at(0)).length, "false date");
});
check("time phrases", () => {
  assert.strictEqual(R.retParseTime("last 3 days", NOW).mode, "received");
  assert.strictEqual(R.retParseTime("next week deadlines", NOW).start.getDate(), 19);
  assert.strictEqual(R.retParseTime("anything on friday?", NOW).start.getDate(), 16);
  assert.strictEqual(R.retParseTime("hello", NOW), null);
});

console.log(failures ? `${failures} failing` : "all retrieval checks pass");
process.exit(failures ? 1 : 0);
