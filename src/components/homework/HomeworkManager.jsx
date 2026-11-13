import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStudentIdentity, hwFetch } from "../../utils/homeworkApi";

export default function HomeworkManager() {
  const [modalOpen, setModalOpen] = useState(false);
  const [classes, setClasses] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [selectedClassId, setSelectedClassId] = useState(null); // null = Classes list, string = inside Class
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinStatus, setJoinStatus] = useState(null);
  const [activeHw, setActiveHw] = useState(null);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [summaryModal, setSummaryModal] = useState(null);

  const activeHwRef = useRef(null);
  activeHwRef.current = activeHw;
  const sessionAnswersRef = useRef({});

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

  const loadHomework = useCallback(
    async (silent = false) => {
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
        const clsList = res.classes || [];
        const db = (window.App && window.App.DB) || [];
        const dbById = {};
        for (const q of db) {
          if (q && q.id) dbById[q.id] = q;
        }

        const asgList = (res.assignments || []).map((a) => {
          if (!a.completed) return a;
          const latestAns =
            typeof a.latestAnswers === "string"
              ? (() => {
                  try {
                    return JSON.parse(a.latestAnswers) || {};
                  } catch (e) {
                    return {};
                  }
                })()
              : a.latestAnswers || {};
          let localScore = 0;
          for (const qid of a.questionIds || []) {
            const pick = String(latestAns[qid] || "").trim().toUpperCase();
            const corr =
              dbById[qid] && dbById[qid].correct
                ? String(dbById[qid].correct).trim().toUpperCase()
                : "";
            if (pick && corr && pick === corr) localScore++;
          }
          return {
            ...a,
            bestScore: Math.max(a.bestScore || 0, localScore),
            latestScore: Math.max(a.latestScore || 0, localScore),
          };
        });

        setClasses(clsList);
        setAssignments(asgList);
        updateTopBadge(asgList);
      }
    },
    [updateTopBadge]
  );

  const computeAnsweredCount = useCallback((hw) => {
    if (!hw) return 0;
    const appAns = (window.App && window.App.S && window.App.S.answers) || {};
    const sessAns = sessionAnswersRef.current || {};
    let c = 0;
    for (const qid of hw.questionIds || []) {
      if (sessAns[qid] || appAns[qid]) c++;
    }
    return c;
  }, []);

  useEffect(() => {
    const btn = document.getElementById("homeworkbtn");

    const handleOpen = () => {
      setJoinStatus(null);
      setShowJoinForm(false);
      setSelectedClassId(null);
      setModalOpen(true);
      loadHomework(false);
    };

    if (btn) btn.addEventListener("click", handleOpen);

    const t0 = setTimeout(() => loadHomework(true), 1200);
    const iv = setInterval(() => loadHomework(true), 20000);

    const onAnswer = (ev) => {
      if (ev && ev.detail && ev.detail.qid && ev.detail.selected) {
        sessionAnswersRef.current[ev.detail.qid] = ev.detail.selected;
      }
      if (activeHwRef.current) {
        const cnt = computeAnsweredCount(activeHwRef.current);
        setAnsweredCount(cnt);
        if (window.App && window.App.banner) {
          window.App.banner(
            `HOMEWORK · ${activeHwRef.current.title.toUpperCase()} (${cnt}/${activeHwRef.current.total})`
          );
        }
      }
    };
    window.addEventListener("satbank:answer", onAnswer);

    return () => {
      if (btn) btn.removeEventListener("click", handleOpen);
      clearTimeout(t0);
      clearInterval(iv);
      window.removeEventListener("satbank:answer", onAnswer);
    };
  }, [loadHomework, computeAnsweredCount]);

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
      setShowJoinForm(false);
      setJoinStatus(null);
      await loadHomework(false);
      if (res.class && res.class.id) {
        setSelectedClassId(res.class.id);
      }
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

  const startHomeworkSession = (assignment, clearExistingAnswers = true) => {
    if (!window.App || !Array.isArray(window.App.DB)) return;
    const db = window.App.DB;
    const qidSet = new Set(assignment.questionIds || []);
    const idxs = [];

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

    sessionAnswersRef.current = {};
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
      window.App.banner(`HOMEWORK · ${assignment.title.toUpperCase()} (${cnt}/${assignment.total})`);
    }
    if (window.App.renderQ) window.App.renderQ();
  };

  const exitHomeworkSession = () => {
    sessionAnswersRef.current = {};
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
    const sessAnswers = sessionAnswersRef.current || {};
    const db = (window.App && window.App.DB) || [];
    const dbById = {};
    for (const q of db) {
      if (q && q.id) dbById[q.id] = q;
    }

    const hwAnswers = {};
    const correctMap = {};
    const localResults = {};
    let localScore = 0;

    for (const qid of activeHw.questionIds || []) {
      const picked = String(sessAnswers[qid] || allAnswers[qid] || "")
        .trim()
        .toUpperCase();
      if (picked && ["A", "B", "C", "D"].includes(picked)) {
        hwAnswers[qid] = picked;
      }
      const corr =
        dbById[qid] && dbById[qid].correct
          ? String(dbById[qid].correct).trim().toUpperCase()
          : "";
      if (corr) correctMap[qid] = corr;
      const isCorrect = Boolean(picked && corr && picked === corr);
      if (isCorrect) localScore++;
      localResults[qid] = {
        selected: picked || null,
        correct: corr || null,
        isCorrect,
      };
    }

    setSubmitting(true);
    const res = await hwFetch(`/api/student/homework/${encodeURIComponent(activeHw.id)}/submit`, {
      method: "POST",
      body: { name, pin, answers: hwAnswers, correct_map: correctMap },
    });
    setSubmitting(false);

    if (res && res.ok) {
      const srvSummary = res.summary || {};
      const finalScore = Math.max(srvSummary.score || 0, localScore);
      const finalBest = Math.max(srvSummary.bestScore || 0, activeHw.bestScore || 0, finalScore);
      setSummaryModal({
        assignment: activeHw,
        summary: {
          ...srvSummary,
          score: finalScore,
          total: activeHw.total || (activeHw.questionIds || []).length,
          bestScore: finalBest,
        },
        results: localResults,
      });
      loadHomework(true);
    } else {
      if (window.toast) window.toast("Could not submit homework. Check connection.");
    }
  };

  const hasIdentity = Boolean(getStudentIdentity().name && getStudentIdentity().pin);
  const selectedClass = classes.find((c) => c.id === selectedClassId) || null;
  const classHomeworks = selectedClass
    ? assignments.filter((a) => a.classId === selectedClass.id)
    : [];

  const getStatusInfo = (a) => {
    const now = new Date();
    const due = a.dueAt ? new Date(a.dueAt) : null;
    const isPastDue = due ? now > due : false;
    const dueStr = due
      ? due.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : null;

    if (a.completed) {
      const pct = a.total > 0 ? Math.round((a.bestScore / a.total) * 100) : 0;
      return {
        type: "completed",
        badge: a.isLate ? "Completed Late" : "Completed",
        scoreText: `${a.bestScore}/${a.total} (${pct}%)`,
        dueStr,
      };
    }
    if (isPastDue) {
      return {
        type: "overdue",
        badge: "Deadline Passed",
        scoreText: null,
        dueStr,
      };
    }
    return {
      type: "pending",
      badge: dueStr ? `Due ${dueStr}` : "Assigned",
      scoreText: null,
      dueStr,
    };
  };

  return (
    <>
      {/* Sleek Bottom Pill when Practicing Homework */}
      {activeHw && (
        <div className="hw-active-bar">
          <div className="hw-active-info">
            <span className="hw-active-dot"></span>
            <span className="hw-active-title">{activeHw.title}</span>
            <span className="hw-active-progress">
              {answeredCount}/{activeHw.total}
            </span>
          </div>
          <div className="hw-active-actions">
            <button
              type="button"
              className="hw-btn-submit"
              onClick={handleSubmitHomework}
              disabled={submitting}
            >
              {submitting ? "Saving..." : "Submit"}
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

      {/* Minimalist Student Homework Modal */}
      <div
        className={`overlay ${modalOpen ? "open" : ""}`}
        id="ov-homework"
        onClick={(e) => {
          if (e.target.id === "ov-homework") setModalOpen(false);
        }}
      >
        <div className="modal hw-modal" onClick={(e) => e.stopPropagation()}>
          {/* Top Header */}
          {selectedClass ? (
            <div className="hw-drill-head">
              <button
                type="button"
                className="hw-back-btn"
                onClick={() => setSelectedClassId(null)}
              >
                ← Classes
              </button>
              <h2 className="hw-drill-title">{selectedClass.name}</h2>
              <span style={{ width: "68px" }}></span>
            </div>
          ) : (
            <>
              <h2 className="chall-title">Homework</h2>
              <div className="chall-rule"></div>
            </>
          )}

          {/* Body Content */}
          <div className="hw-body-wrap">
            {!hasIdentity ? (
              <div className="opp-empty" style={{ marginTop: "20px" }}>
                Save your name in the bottom-left bar to view classes and homework.
              </div>
            ) : loading ? (
              <div
                className="skel"
                style={{ height: "120px", borderRadius: "16px", marginTop: "20px" }}
              ></div>
            ) : selectedClass ? (
              /* VIEW 2: HOMEWORKS INSIDE SELECTED CLASS (Unified List) */
              <div className="hw-list" style={{ marginTop: "16px" }}>
                {classHomeworks.length === 0 ? (
                  <div className="opp-empty">No homework assigned in {selectedClass.name} yet.</div>
                ) : (
                  classHomeworks.map((a, idx) => {
                    const st = getStatusInfo(a);
                    return (
                      <div
                        key={a.id}
                        className="hw-card"
                        style={{ animationDelay: `${Math.min(idx * 35, 180)}ms` }}
                      >
                        <div className="hw-card-main">
                          <div className="hw-card-top">
                            <span className={`hw-status-pill ${st.type}`}>
                              {st.badge}
                            </span>
                            {st.scoreText && (
                              <span className="hw-score-highlight">{st.scoreText}</span>
                            )}
                          </div>
                          <div className="hw-card-title">{a.title}</div>
                          <div className="hw-card-meta">
                            <span>{a.total} questions</span>
                            {a.domainFilter && <span>· {a.domainFilter}</span>}
                            {a.difficultyFilter && <span>· {a.difficultyFilter}</span>}
                            {a.attemptsCount > 0 && (
                              <span>
                                · {a.attemptsCount} {a.attemptsCount === 1 ? "try" : "tries"}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`hw-action-btn ${a.completed ? "ghost" : "primary"}`}
                          onClick={() => startHomeworkSession(a, true)}
                        >
                          {a.completed ? "Practice" : "Start"}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              /* VIEW 1: CLASSES LIST */
              <div style={{ marginTop: "20px" }}>
                {classes.length > 0 && (
                  <div className="hw-list">
                    {classes.map((c, idx) => {
                      const cAssigns = assignments.filter((a) => a.classId === c.id);
                      const doneCount = cAssigns.filter((a) => a.completed).length;
                      const pendingCount = cAssigns.length - doneCount;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className="hw-class-card"
                          style={{ animationDelay: `${Math.min(idx * 35, 180)}ms` }}
                          onClick={() => setSelectedClassId(c.id)}
                        >
                          <div className="hw-class-card-left">
                            <div className="hw-class-avatar">
                              {c.name.slice(0, 2).toUpperCase()}
                            </div>
                            <div className="hw-class-info">
                              <div className="hw-class-title">{c.name}</div>
                              <div className="hw-class-sub">
                                {cAssigns.length === 0
                                  ? "No assignments yet"
                                  : pendingCount > 0
                                  ? `${pendingCount} to do · ${doneCount} completed`
                                  : `All ${doneCount} completed`}
                              </div>
                            </div>
                          </div>
                          <div className="hw-class-card-right">
                            {pendingCount > 0 && (
                              <span className="hw-pending-dot">{pendingCount}</span>
                            )}
                            <span className="hw-chevron">›</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Join Class Form: shown automatically if 0 classes, or when toggled */}
                {classes.length === 0 || showJoinForm ? (
                  <form
                    className="hw-join-bar"
                    style={{ marginTop: classes.length > 0 ? "14px" : "0" }}
                    onSubmit={handleJoinClass}
                  >
                    <input
                      type="text"
                      className="hw-join-input"
                      placeholder="Enter class code..."
                      maxLength={8}
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      autoFocus
                    />
                    <button type="submit" className="hw-join-btn">
                      Join
                    </button>
                  </form>
                ) : (
                  <div className="hw-add-class-row">
                    <button
                      type="button"
                      className="hw-join-toggle"
                      onClick={() => {
                        setJoinStatus(null);
                        setShowJoinForm(true);
                      }}
                    >
                      + Join another class
                    </button>
                  </div>
                )}

                {joinStatus && (
                  <div className={`hw-status-msg ${joinStatus.ok ? "ok" : "err"}`}>
                    {joinStatus.msg}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="hw-footer-row">
            <button
              type="button"
              className="hw-close-link"
              onClick={() => setModalOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Minimalist Homework Results Modal */}
      {summaryModal && (
        <div
          className="overlay open"
          id="ov-hw-summary"
          onClick={() => setSummaryModal(null)}
        >
          <div className="modal hw-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="chall-title">
              {summaryModal.summary.score} / {summaryModal.summary.total}
            </h2>
            <div className="hw-sum-subtitle">{summaryModal.assignment.title}</div>
            <div className="chall-rule"></div>

            <div className="hw-sum-stats">
              <div className="hw-sum-box">
                <div className="hw-sum-label">Accuracy</div>
                <div className="hw-sum-val">
                  {summaryModal.summary.total > 0
                    ? Math.round(
                        (summaryModal.summary.score / summaryModal.summary.total) * 100
                      )
                    : 0}
                  %
                </div>
              </div>
              <div className="hw-sum-box">
                <div className="hw-sum-label">Best</div>
                <div className="hw-sum-val">
                  {summaryModal.summary.bestScore}/{summaryModal.summary.total}
                </div>
              </div>
              <div className="hw-sum-box">
                <div className="hw-sum-label">Attempt</div>
                <div className="hw-sum-val">#{summaryModal.summary.attemptNumber}</div>
              </div>
            </div>

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

            <div className="hw-sum-actions">
              <button
                type="button"
                className="hw-action-btn ghost"
                onClick={() => setSummaryModal(null)}
              >
                Review
              </button>
              <button
                type="button"
                className="hw-action-btn ghost"
                onClick={() => startHomeworkSession(summaryModal.assignment, true)}
              >
                Retry
              </button>
              <button
                type="button"
                className="hw-action-btn primary"
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
