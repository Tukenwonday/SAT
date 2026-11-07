import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStudentIdentity, hwFetch } from "../../utils/homeworkApi";

export default function HomeworkManager({ onOpenTeacher }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [tab, setTab] = useState("active"); // "active" | "completed"
  const [classes, setClasses] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinStatus, setJoinStatus] = useState(null); // { ok: boolean, msg: string }
  const [activeHw, setActiveHw] = useState(null); // currently practicing assignment object
  const [answeredCount, setAnsweredCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [summaryModal, setSummaryModal] = useState(null); // { assignment, summary, results }

  const activeHwRef = useRef(null);
  activeHwRef.current = activeHw;

  const updateTopBadge = useCallback((list) => {
    const badge = document.getElementById("hw-badge");
    if (!badge) return;
    const pendingCount = (list || []).filter((a) => !a.completed).length;
    if (pendingCount > 0) {
      badge.textContent = String(pendingCount);
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }, []);

  const loadHomework = useCallback(async (silent = false) => {
    const { name, pin } = getStudentIdentity();
    if (!name || !pin) {
      setClasses([]);
      setAssignments([]);
      updateTopBadge([]);
      return;
    }
    if (!silent) setLoading(true);
    const res = await hwFetch(
      `/api/student/homework?name=${encodeURIComponent(name)}&pin=${encodeURIComponent(pin)}`
    );
    if (!silent) setLoading(false);
    if (res && res.ok) {
      setClasses(res.classes || []);
      setAssignments(res.assignments || []);
      updateTopBadge(res.assignments || []);
    }
  }, [updateTopBadge]);

  const computeAnsweredCount = useCallback((hw) => {
    if (!hw || !window.App || !window.App.S) return 0;
    const ans = window.App.S.answers || {};
    let c = 0;
    for (const qid of hw.questionIds || []) {
      if (ans[qid]) c++;
    }
    return c;
  }, []);

  // Wire topbar #homeworkbtn and #mm-teacher
  useEffect(() => {
    const btn = document.getElementById("homeworkbtn");
    const mmTeacher = document.getElementById("mm-teacher");

    const handleOpen = () => {
      setJoinStatus(null);
      setModalOpen(true);
      loadHomework(false);
    };

    const handleTeacher = () => {
      const mm = document.getElementById("moreMenu");
      if (mm) mm.classList.remove("open");
      if (onOpenTeacher) onOpenTeacher();
    };

    if (btn) btn.addEventListener("click", handleOpen);
    if (mmTeacher) mmTeacher.addEventListener("click", handleTeacher);

    // Initial fetch + periodic refresh
    const t0 = setTimeout(() => loadHomework(true), 1200);
    const iv = setInterval(() => loadHomework(true), 20000);

    // Listen to answer events from examEngine
    const onAnswer = () => {
      if (activeHwRef.current) {
        const cnt = computeAnsweredCount(activeHwRef.current);
        setAnsweredCount(cnt);
        if (window.App && window.App.banner) {
          window.App.banner(
            `HOMEWORK: ${activeHwRef.current.title.toUpperCase()} (${cnt}/${activeHwRef.current.total})`
          );
        }
      }
    };
    window.addEventListener("satbank:answer", onAnswer);

    return () => {
      if (btn) btn.removeEventListener("click", handleOpen);
      if (mmTeacher) mmTeacher.removeEventListener("click", handleTeacher);
      clearTimeout(t0);
      clearInterval(iv);
      window.removeEventListener("satbank:answer", onAnswer);
    };
  }, [loadHomework, computeAnsweredCount, onOpenTeacher]);

  // Listen for real-time socket homework updates if Net.socket is connected
  useEffect(() => {
    const iv = setInterval(() => {
      const sock = window.Net && window.Net.socket;
      if (sock && !sock._hwBound) {
        sock._hwBound = true;
        sock.on("homework:updated", () => {
          loadHomework(true);
        });
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [loadHomework]);

  const handleJoinClass = async (e) => {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!code) return;

    const { name, pin } = getStudentIdentity();
    if (!name || !pin) {
      setJoinStatus({ ok: false, msg: "Save your name and PIN in the bottom bar first." });
      return;
    }

    setJoinStatus(null);
    const res = await hwFetch("/api/student/classes/join", {
      method: "POST",
      body: { name, pin, join_code: code },
    });

    if (res && res.ok) {
      setJoinCode("");
      setJoinStatus({ ok: true, msg: `Joined ${res.class.name}` });
      loadHomework(false);
    } else {
      const errMap = {
        "invalid-join-code": "Class code not found.",
        "unknown-user": "Save your name in the bottom bar first.",
        "bad-pin": "PIN mismatch. Check your PIN in the bottom bar.",
      };
      setJoinStatus({
        ok: false,
        msg: errMap[res?.error] || "Could not join class.",
      });
    }
  };

  const handleLeaveClass = async (classId) => {
    const { name, pin } = getStudentIdentity();
    if (!name || !pin) return;
    await hwFetch("/api/student/classes/leave", {
      method: "POST",
      body: { name, pin, class_id: classId },
    });
    loadHomework(false);
  };

  const startHomeworkSession = (assignment, clearExistingAnswers = true) => {
    if (!window.App || !Array.isArray(window.App.DB)) return;
    const db = window.App.DB;
    const qidSet = new Set(assignment.questionIds || []);
    const idxs = [];

    // Preserve exact order of assignment.questionIds
    const idToIdx = {};
    db.forEach((q, idx) => {
      if (q && qidSet.has(q.id)) idToIdx[q.id] = idx;
    });
    for (const qid of assignment.questionIds || []) {
      if (idToIdx[qid] !== undefined) idxs.push(idToIdx[qid]);
    }

    if (!idxs.length) {
      if (window.toast) window.toast("Questions for this assignment were not found.");
      return;
    }

    if (clearExistingAnswers && window.App.S && window.App.S.answers) {
      for (const qid of assignment.questionIds || []) {
        delete window.App.S.answers[qid];
        if (window.App.S.elim) delete window.App.S.elim[qid];
      }
    }

    setActiveHw(assignment);
    setSummaryModal(null);
    setModalOpen(false);

    window.App.setChallenge(idxs, true);
    const cnt = computeAnsweredCount(assignment);
    setAnsweredCount(cnt);
    if (window.App.banner) {
      window.App.banner(`HOMEWORK: ${assignment.title.toUpperCase()} (${cnt}/${assignment.total})`);
    }
    if (window.App.renderQ) window.App.renderQ();
  };

  const exitHomeworkSession = () => {
    setActiveHw(null);
    setSummaryModal(null);
    if (window.App) {
      if (window.App.setChallenge) window.App.setChallenge(null, false);
      if (window.App.banner) window.App.banner(null);
      if (window.App.renderQ) window.App.renderQ();
    }
  };

  const handleSubmitHomework = async () => {
    if (!activeHw || submitting) return;
    const { name, pin } = getStudentIdentity();
    if (!name || !pin) {
      if (window.toast) window.toast("Save your name and PIN in the bottom bar first.");
      return;
    }

    const allAnswers = (window.App && window.App.S && window.App.S.answers) || {};
    const hwAnswers = {};
    for (const qid of activeHw.questionIds || []) {
      if (allAnswers[qid]) hwAnswers[qid] = allAnswers[qid];
    }

    setSubmitting(true);
    const res = await hwFetch(`/api/student/homework/${encodeURIComponent(activeHw.id)}/submit`, {
      method: "POST",
      body: { name, pin, answers: hwAnswers },
    });
    setSubmitting(false);

    if (res && res.ok) {
      setSummaryModal({
        assignment: activeHw,
        summary: res.summary,
        results: res.results || {},
      });
      loadHomework(true);
    } else {
      if (window.toast) window.toast("Could not submit homework. Check connection.");
    }
  };

  const activeList = assignments.filter((a) => !a.completed);
  const completedList = assignments.filter((a) => a.completed);
  const hasIdentity = Boolean(getStudentIdentity().name && getStudentIdentity().pin);

  const formatDue = (dueAt) => {
    if (!dueAt) return null;
    const d = new Date(dueAt);
    const isPast = new Date() > d;
    const str = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return { str, isPast };
  };

  return (
    <>
      {/* Floating Homework Bar when actively practicing an assignment */}
      {activeHw && (
        <div className="hw-active-bar">
          <div className="hw-active-info">
            <span className="hw-active-tag">HOMEWORK</span>
            <span className="hw-active-title">{activeHw.title}</span>
            <span className="hw-active-progress">
              {answeredCount} / {activeHw.total} Answered
            </span>
          </div>
          <div className="hw-active-actions">
            <button
              type="button"
              className="hw-btn-submit"
              onClick={handleSubmitHomework}
              disabled={submitting}
            >
              {submitting ? "Submitting..." : "Submit Homework"}
            </button>
            <button
              type="button"
              className="hw-btn-exit"
              onClick={exitHomeworkSession}
            >
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Main Student Homework Modal */}
      <div
        className={`overlay ${modalOpen ? "open" : ""}`}
        id="ov-homework"
        onClick={(e) => {
          if (e.target.id === "ov-homework") setModalOpen(false);
        }}
      >
        <div className="modal hw-modal" onClick={(e) => e.stopPropagation()}>
          <div className="hw-modal-head">
            <h2 className="chall-title" style={{ margin: 0 }}>Homework</h2>
            <button
              type="button"
              className="hw-close-icon"
              onClick={() => setModalOpen(false)}
            >
              Close
            </button>
          </div>
          <div className="chall-rule"></div>

          {!hasIdentity && (
            <div className="hw-notice">
              Enter your name and click Save in the bottom-left bar to sync classes and homework.
            </div>
          )}

          {/* Join Class Bar */}
          <form className="hw-join-bar" onSubmit={handleJoinClass}>
            <input
              type="text"
              className="hw-join-input"
              placeholder="Class code (e.g. SAT842)"
              maxLength={8}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            />
            <button type="submit" className="btn-blue hw-join-btn">
              Join Class
            </button>
          </form>

          {joinStatus && (
            <div className={`hw-status-msg ${joinStatus.ok ? "ok" : "err"}`}>
              {joinStatus.msg}
            </div>
          )}

          {/* Enrolled Classes Pills */}
          {classes.length > 0 && (
            <div className="hw-classes-row">
              {classes.map((c) => (
                <span key={c.id} className="hw-class-pill">
                  <span>{c.name}</span>
                  <span className="hw-class-code">{c.join_code}</span>
                  <button
                    type="button"
                    className="hw-class-leave"
                    title="Leave class"
                    onClick={() => handleLeaveClass(c.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Active / Completed Tabs */}
          <div className="chall-pick hw-tabs">
            <button
              type="button"
              className={tab === "active" ? "sel" : ""}
              onClick={() => setTab("active")}
            >
              Active ({activeList.length})
            </button>
            <button
              type="button"
              className={tab === "completed" ? "sel" : ""}
              onClick={() => setTab("completed")}
            >
              Completed ({completedList.length})
            </button>
          </div>

          {/* Assignment List */}
          <div className="hw-list">
            {loading ? (
              <div className="skel" style={{ height: "110px" }}></div>
            ) : tab === "active" ? (
              activeList.length === 0 ? (
                <div className="opp-empty">
                  {classes.length === 0
                    ? "No classes joined yet. Enter a class code above."
                    : "No pending homework assignments."}
                </div>
              ) : (
                activeList.map((a) => {
                  const due = formatDue(a.dueAt);
                  return (
                    <div key={a.id} className="hw-card">
                      <div className="hw-card-main">
                        <div className="hw-card-top">
                          <span className="hw-card-class">{a.className}</span>
                          {due && (
                            <span className={`hw-due-tag ${due.isPast ? "late" : ""}`}>
                              Due {due.str}
                            </span>
                          )}
                        </div>
                        <div className="hw-card-title">{a.title}</div>
                        <div className="hw-card-meta">
                          <span>{a.total} Questions</span>
                          {a.domainFilter && <span>· {a.domainFilter}</span>}
                          {a.difficultyFilter && <span>· {a.difficultyFilter}</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-blue hw-start-btn"
                        onClick={() => startHomeworkSession(a, true)}
                      >
                        Start
                      </button>
                    </div>
                  );
                })
              )
            ) : completedList.length === 0 ? (
              <div className="opp-empty">No completed assignments yet.</div>
            ) : (
              completedList.map((a) => {
                const bestPct = a.total > 0 ? Math.round((a.bestScore / a.total) * 100) : 0;
                return (
                  <div key={a.id} className="hw-card completed">
                    <div className="hw-card-main">
                      <div className="hw-card-top">
                        <span className="hw-card-class">{a.className}</span>
                        {a.isLate && <span className="hw-due-tag late">Submitted Late</span>}
                      </div>
                      <div className="hw-card-title">{a.title}</div>
                      <div className="hw-card-meta">
                        <span className="hw-score-highlight">
                          Best: {a.bestScore} / {a.total} ({bestPct}%)
                        </span>
                        <span>
                          · {a.attemptsCount} {a.attemptsCount === 1 ? "attempt" : "attempts"}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-ghost hw-start-btn"
                      onClick={() => startHomeworkSession(a, true)}
                    >
                      Practice Again
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Homework Submission Results Modal */}
      {summaryModal && (
        <div
          className="overlay open"
          id="ov-hw-summary"
          onClick={() => setSummaryModal(null)}
        >
          <div className="modal hw-summary-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="chall-title" style={{ marginBottom: "4px" }}>
              Homework Submitted
            </h2>
            <div className="hw-sum-subtitle">{summaryModal.assignment.title}</div>
            <div className="chall-rule"></div>

            <div className="hw-sum-stats">
              <div className="hw-sum-box">
                <div className="hw-sum-label">Score</div>
                <div className="hw-sum-val">
                  {summaryModal.summary.score} / {summaryModal.summary.total}
                </div>
              </div>
              <div className="hw-sum-box">
                <div className="hw-sum-label">Best Score</div>
                <div className="hw-sum-val">
                  {summaryModal.summary.bestScore} / {summaryModal.summary.total}
                </div>
              </div>
              <div className="hw-sum-box">
                <div className="hw-sum-label">Attempt</div>
                <div className="hw-sum-val">#{summaryModal.summary.attemptNumber}</div>
              </div>
            </div>

            <div className="fsec">Question Breakdown (Click to Review)</div>
            <div className="hw-sum-grid">
              {(summaryModal.assignment.questionIds || []).map((qid, i) => {
                const r = summaryModal.results[qid] || {};
                const statusCls = r.isCorrect ? "ok" : r.selected ? "bad" : "skip";
                return (
                  <button
                    key={qid}
                    type="button"
                    className={`hw-q-pill ${statusCls}`}
                    onClick={() => {
                      setSummaryModal(null);
                      if (window.App && window.App.jumpToQid) {
                        window.App.jumpToQid(qid);
                      }
                    }}
                  >
                    <span>{i + 1}</span>
                    <small>{r.selected || "–"}</small>
                  </button>
                );
              })}
            </div>

            <div className="mrow" style={{ marginTop: "20px" }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setSummaryModal(null)}
              >
                Review Explanations
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => startHomeworkSession(summaryModal.assignment, true)}
              >
                Retry Fresh
              </button>
              <button
                type="button"
                className="btn-blue"
                onClick={exitHomeworkSession}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

