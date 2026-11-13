import React, { useState, useEffect, useCallback, useMemo } from "react";
import { hwFetch, loadClientSatDb } from "../../utils/homeworkApi";

const DOMAINS = [
  "Information and Ideas",
  "Craft and Structure",
  "Expression of Ideas",
  "Standard English Conventions",
];
const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const COUNT_PRESETS = [5, 10, 15, 20];

export default function TeacherPortal({ onExit }) {
  const [teacherKey, setTeacherKey] = useState(
    () => sessionStorage.getItem("satbank:teacherKey") || ""
  );
  const [authed, setAuthed] = useState(false);
  const [pwdInput, setPwdInput] = useState("");
  const [authErr, setAuthErr] = useState("");

  // Question Bank loaded on client from /sat_db.json
  const [questionBank, setQuestionBank] = useState([]);

  // Classes & Active Class
  const [classes, setClasses] = useState([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [classStudents, setClassStudents] = useState([]);
  const [classAssignments, setClassAssignments] = useState([]);
  const [creatingClass, setCreatingClass] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [copiedCode, setCopiedCode] = useState("");

  // View inside selected class: "overview" | "new-assignment" | "gradebook"
  const [subView, setSubView] = useState("overview");

  // New Assignment form state
  const [assignTitle, setAssignTitle] = useState("");
  const [assignDue, setAssignDue] = useState("");
  const [pickMode, setPickMode] = useState("filter"); // "filter" | "manual"
  const [filterDomain, setFilterDomain] = useState("All");
  const [filterDiff, setFilterDiff] = useState("All");
  const [filterCount, setFilterCount] = useState(10);

  // Manual Question Picker state (client-side instant filtering)
  const [qSearch, setQSearch] = useState("");
  const [qDomain, setQDomain] = useState("All");
  const [qDiff, setQDiff] = useState("All");
  const [qPage, setQPage] = useState(1);
  const [selectedQIds, setSelectedQIds] = useState([]);
  const [expandedQId, setExpandedQId] = useState(null);
  const [createMsg, setCreateMsg] = useState(null);
  const [creatingAssign, setCreatingAssign] = useState(false);

  // Gradebook & Analytics state
  const [analyticsData, setAnalyticsData] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsTab, setAnalyticsTab] = useState("questions"); // "students" | "questions"
  const [qSort, setQSort] = useState("order"); // "order" | "hardest"
  const [expandedAnalyticsQId, setExpandedAnalyticsQId] = useState(null);
  const [inspectStudent, setInspectStudent] = useState(null);

  const tFetch = useCallback(
    (path, opts = {}) =>
      hwFetch(path, {
        ...opts,
        headers: {
          "x-teacher-key": teacherKey,
          ...(opts.headers || {}),
        },
      }),
    [teacherKey]
  );

  // Load client question bank once
  useEffect(() => {
    loadClientSatDb().then((db) => {
      if (Array.isArray(db)) setQuestionBank(db);
    });
  }, []);

  const qById = useMemo(() => {
    const map = {};
    for (const q of questionBank) {
      if (q && q.id) map[q.id] = q;
    }
    return map;
  }, [questionBank]);

  // Verify stored teacherKey on mount
  useEffect(() => {
    if (!teacherKey) return;
    tFetch("/api/teacher/classes").then((res) => {
      if (res && res.ok) {
        setAuthed(true);
        const list = res.classes || [];
        setClasses(list);
        if (list.length > 0 && !selectedClassId) {
          setSelectedClassId(list[0].id);
        }
      } else {
        setAuthed(false);
        sessionStorage.removeItem("satbank:teacherKey");
      }
    });
  }, [teacherKey, tFetch, selectedClassId]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthErr("");
    const pwd = pwdInput.trim();
    if (!pwd) return;
    const res = await hwFetch("/api/teacher/auth", {
      method: "POST",
      body: { password: pwd },
    });
    if (res && res.ok) {
      sessionStorage.setItem("satbank:teacherKey", pwd);
      setTeacherKey(pwd);
      setAuthed(true);
    } else {
      setAuthErr("Incorrect passcode.");
    }
  };

  const loadClasses = useCallback(async () => {
    const res = await tFetch("/api/teacher/classes");
    if (res && res.ok) {
      const list = res.classes || [];
      setClasses(list);
      if (list.length > 0 && !selectedClassId) {
        setSelectedClassId(list[0].id);
      }
    }
  }, [tFetch, selectedClassId]);

  const loadClassDetails = useCallback(
    async (cid) => {
      if (!cid) {
        setClassStudents([]);
        setClassAssignments([]);
        return;
      }
      const [stRes, asRes] = await Promise.all([
        tFetch(`/api/teacher/classes/${encodeURIComponent(cid)}/students`),
        tFetch(`/api/teacher/classes/${encodeURIComponent(cid)}/assignments`),
      ]);
      if (stRes && stRes.ok) setClassStudents(stRes.students || []);
      if (asRes && asRes.ok) setClassAssignments(asRes.assignments || []);
    },
    [tFetch]
  );

  useEffect(() => {
    if (authed && selectedClassId) {
      loadClassDetails(selectedClassId);
    }
  }, [authed, selectedClassId, loadClassDetails]);

  // Filter pool for Auto-Generate mode
  const matchingAutoPool = useMemo(() => {
    return questionBank.filter((q) => {
      if (!q || !q.id) return false;
      if (filterDomain !== "All" && q.domain !== filterDomain) return false;
      if (filterDiff !== "All" && q.difficulty !== filterDiff) return false;
      return true;
    });
  }, [questionBank, filterDomain, filterDiff]);

  // Filtered questions for Manual Hand-Pick mode
  const filteredManualQuestions = useMemo(() => {
    const term = qSearch.trim().toLowerCase();
    return questionBank.filter((q) => {
      if (!q || !q.id) return false;
      if (qDomain !== "All" && q.domain !== qDomain) return false;
      if (qDiff !== "All" && q.difficulty !== qDiff) return false;
      if (term) {
        const hay = `${q.id} ${q.skill || ""} ${q.question || ""}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [questionBank, qDomain, qDiff, qSearch]);

  const pageSize = 15;
  const totalManualPages = Math.max(1, Math.ceil(filteredManualQuestions.length / pageSize));
  const currentManualSlice = useMemo(() => {
    const start = (qPage - 1) * pageSize;
    return filteredManualQuestions.slice(start, start + pageSize);
  }, [filteredManualQuestions, qPage]);

  const handleCreateClass = async (e) => {
    e.preventDefault();
    const name = newClassName.trim();
    if (!name) return;
    const res = await tFetch("/api/teacher/classes", {
      method: "POST",
      body: { name },
    });
    if (res && res.ok) {
      setNewClassName("");
      setCreatingClass(false);
      await loadClasses();
      setSelectedClassId(res.class.id);
      setSubView("overview");
    }
  };

  const handleDeleteClass = async (cid) => {
    if (!window.confirm("Delete this class and all of its assignments?")) return;
    const res = await tFetch(`/api/teacher/classes/${encodeURIComponent(cid)}`, {
      method: "DELETE",
    });
    if (res && res.ok) {
      const next = classes.filter((c) => c.id !== cid);
      setClasses(next);
      setSelectedClassId(next[0]?.id || "");
      setSubView("overview");
    }
  };

  const handleRemoveStudent = async (studentName) => {
    if (!selectedClassId) return;
    if (!window.confirm(`Remove ${studentName} from this class?`)) return;
    await tFetch(
      `/api/teacher/classes/${encodeURIComponent(selectedClassId)}/students/${encodeURIComponent(studentName)}`,
      { method: "DELETE" }
    );
    loadClassDetails(selectedClassId);
    loadClasses();
  };

  const toggleSelectQ = (qid) => {
    setSelectedQIds((prev) =>
      prev.includes(qid) ? prev.filter((id) => id !== qid) : [...prev, qid]
    );
  };

  const handleCreateAssignment = async (e) => {
    e.preventDefault();
    setCreateMsg(null);
    if (!selectedClassId) {
      setCreateMsg({ ok: false, text: "Create a class first." });
      return;
    }
    if (!assignTitle.trim()) {
      setCreateMsg({ ok: false, text: "Enter an assignment title." });
      return;
    }

    let finalQuestionIds = [];
    if (pickMode === "manual") {
      if (selectedQIds.length === 0) {
        setCreateMsg({ ok: false, text: "Select at least one question." });
        return;
      }
      finalQuestionIds = selectedQIds;
    } else {
      const wantCount = Math.min(50, Math.max(1, Number(filterCount) || 10));
      let pool = matchingAutoPool.slice();
      if (pool.length === 0) {
        setCreateMsg({ ok: false, text: "No questions match those filters." });
        return;
      }
      const alreadyUsed = new Set();
      classAssignments.forEach((a) => {
        (a.question_ids || []).forEach((id) => alreadyUsed.add(id));
      });
      const freshPool = pool.filter((q) => !alreadyUsed.has(q.id));
      const sourcePool = freshPool.length >= wantCount ? freshPool : pool;

      const shuffled = sourcePool.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      finalQuestionIds = shuffled.slice(0, wantCount).map((q) => q.id);
    }

    setCreatingAssign(true);
    const res = await tFetch(
      `/api/teacher/classes/${encodeURIComponent(selectedClassId)}/assignments`,
      {
        method: "POST",
        body: {
          title: assignTitle.trim(),
          due_at: assignDue ? new Date(assignDue).toISOString() : null,
          domain: pickMode === "filter" && filterDomain !== "All" ? filterDomain : null,
          difficulty: pickMode === "filter" && filterDiff !== "All" ? filterDiff : null,
          count: finalQuestionIds.length,
          question_ids: finalQuestionIds,
        },
      }
    );
    setCreatingAssign(false);

    if (res && res.ok) {
      setAssignTitle("");
      setAssignDue("");
      setSelectedQIds([]);
      setCreateMsg(null);
      await loadClasses();
      await loadClassDetails(selectedClassId);
      setSubView("overview");
    } else {
      setCreateMsg({
        ok: false,
        text: res?.error || "Could not create assignment.",
      });
    }
  };

  const handleDeleteAssignment = async (aid) => {
    if (!window.confirm("Delete this assignment and all student submissions?")) return;
    const res = await tFetch(`/api/teacher/assignments/${encodeURIComponent(aid)}`, {
      method: "DELETE",
    });
    if (res && res.ok) {
      loadClasses();
      loadClassDetails(selectedClassId);
      if (subView === "gradebook") setSubView("overview");
    }
  };

  const openAnalytics = async (assignmentId) => {
    setSubView("gradebook");
    setAnalyticsLoading(true);
    setInspectStudent(null);
    setExpandedAnalyticsQId(null);
    const res = await tFetch(
      `/api/teacher/assignments/${encodeURIComponent(assignmentId)}/analytics`
    );
    setAnalyticsLoading(false);
    if (res && res.ok) {
      setAnalyticsData(res);
    }
  };

  // Re-grade every student's submission history on the client using /sat_db.json
  // so scores and answers are 100% accurate even if sat_db.json is not on the VPS.
  const enrichedStudents = useMemo(() => {
    if (!analyticsData || !Array.isArray(analyticsData.students)) return [];
    const qIds = (analyticsData.assignment && analyticsData.assignment.question_ids) || [];
    const total = qIds.length;

    const parseAns = (raw) => {
      if (!raw) return {};
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) || {};
        } catch (e) {
          return {};
        }
      }
      return typeof raw === "object" ? raw : {};
    };

    const gradeAnswers = (ansObj) => {
      let score = 0;
      let answeredCount = 0;
      for (const qid of qIds) {
        const picked = String(ansObj[qid] || "").trim().toUpperCase();
        if (picked && ["A", "B", "C", "D"].includes(picked)) {
          answeredCount++;
          const localQ = qById[qid];
          const corr = localQ && localQ.correct ? String(localQ.correct).trim().toUpperCase() : "";
          if (corr && picked === corr) {
            score++;
          }
        }
      }
      return { score, answeredCount };
    };

    return analyticsData.students.map((st) => {
      if (!st.completed) return st;

      const hist = Array.isArray(st.history) && st.history.length > 0
        ? st.history
        : [{ answers: st.latestAnswers || st.bestAnswers || {}, score: st.bestScore || 0 }];

      const gradedHist = hist.map((h) => {
        const ansObj = parseAns(h.answers);
        const { score: clientScore, answeredCount } = gradeAnswers(ansObj);
        const finalScore = Object.keys(qById).length > 0 ? clientScore : (h.score || 0);
        return {
          ...h,
          answers: ansObj,
          trueScore: finalScore,
          answeredCount,
        };
      });

      let bestAtt = gradedHist[0];
      for (const att of gradedHist) {
        if (
          att.trueScore > bestAtt.trueScore ||
          (att.trueScore === bestAtt.trueScore && att.answeredCount >= bestAtt.answeredCount)
        ) {
          bestAtt = att;
        }
      }

      // Also merge any answers from latest attempt if bestAtt had fewer answers
      const latestAtt = gradedHist[gradedHist.length - 1];
      const firstAtt = gradedHist[0];
      const mergedAnswers = { ...(latestAtt.answers || {}), ...(bestAtt.answers || {}) };

      const bestScore = bestAtt.trueScore;
      const firstScore = firstAtt.trueScore;
      const latestScore = latestAtt.trueScore;
      const bestPct = total > 0 ? Math.round((bestScore / total) * 100) : 0;

      return {
        ...st,
        bestScore,
        firstScore,
        latestScore,
        total,
        bestPct,
        bestAnswers: mergedAnswers,
        latestAnswers: latestAtt.answers || {},
        answeredCount: Object.keys(mergedAnswers).length,
      };
    });
  }, [analyticsData, qById]);

  // Enrich gradebook questions using client sat_db.json and enrichedStudents
  const enrichedAnalyticsQuestions = useMemo(() => {
    if (!analyticsData || !Array.isArray(analyticsData.questions)) return [];
    const students = enrichedStudents;
    return analyticsData.questions.map((q, idx) => {
      const localQ = qById[q.id] || {};
      const correct = localQ.correct || q.correct || "";
      const counts = { A: 0, B: 0, C: 0, D: 0 };
      const pickedBy = { A: [], B: [], C: [], D: [] };
      let attempted = 0;
      let correctCount = 0;

      for (const st of students) {
        if (!st.completed) continue;
        const ans = String((st.bestAnswers || st.latestAnswers || {})[q.id] || "")
          .trim()
          .toUpperCase();
        if (ans && counts[ans] !== undefined) {
          attempted++;
          counts[ans]++;
          pickedBy[ans].push(st.name);
          if (correct && ans === String(correct).toUpperCase()) {
            correctCount++;
          }
        }
      }

      // Find most common wrong choice (trap answer)
      let trapChoice = null;
      let trapCount = 0;
      ["A", "B", "C", "D"].forEach((k) => {
        if (k !== correct && counts[k] > trapCount) {
          trapCount = counts[k];
          trapChoice = k;
        }
      });

      return {
        ...q,
        index: idx + 1,
        domain: localQ.domain || (q.domain && q.domain !== "Unknown" ? q.domain : "Reading & Writing"),
        skill: localQ.skill || q.skill || "",
        difficulty: localQ.difficulty || q.difficulty || "",
        correct,
        question: localQ.question || q.question || "",
        choices: localQ.choices || q.choices || {},
        rationale: localQ.rationale || q.rationale || "",
        attempted,
        correctCount,
        accuracy: attempted > 0 ? Math.round((correctCount / attempted) * 100) : null,
        choiceCounts: counts,
        pickedBy,
        trapChoice: trapCount > 0 ? { letter: trapChoice, count: trapCount } : null,
      };
    });
  }, [analyticsData, enrichedStudents, qById]);

  // Compute class-level summary KPIs for the assignment
  const analyticsKpis = useMemo(() => {
    if (!analyticsData) return null;
    const students = enrichedStudents;
    const completedStudents = students.filter((s) => s.completed);
    const avgBestPct =
      completedStudents.length > 0
        ? Math.round(
            completedStudents.reduce((acc, s) => acc + (s.bestPct || 0), 0) /
              completedStudents.length
          )
        : null;

    const firstPcts = completedStudents
      .filter((s) => s.firstScore !== null && s.total > 0)
      .map((s) => Math.round((s.firstScore / s.total) * 100));
    const avgFirstPct =
      firstPcts.length > 0
        ? Math.round(firstPcts.reduce((a, b) => a + b, 0) / firstPcts.length)
        : null;

    // Hardest question (lowest accuracy among attempted questions)
    const attemptedQs = enrichedAnalyticsQuestions.filter((q) => q.accuracy !== null);
    let hardestQ = null;
    for (const q of attemptedQs) {
      if (!hardestQ || q.accuracy < hardestQ.accuracy) {
        hardestQ = q;
      }
    }

    // Weakest skill across questions
    const bySkill = {};
    for (const q of attemptedQs) {
      const sk = q.skill || q.domain || "General";
      if (!bySkill[sk]) bySkill[sk] = { earned: 0, total: 0 };
      bySkill[sk].earned += q.correctCount;
      bySkill[sk].total += q.attempted;
    }
    let weakestSkill = null;
    Object.entries(bySkill).forEach(([skill, d]) => {
      if (d.total > 0) {
        const pct = Math.round((d.earned / d.total) * 100);
        if (!weakestSkill || pct < weakestSkill.pct) {
          weakestSkill = { skill, pct };
        }
      }
    });

    return {
      totalStudents: students.length,
      completedCount: completedStudents.length,
      avgBestPct,
      avgFirstPct,
      hardestQ,
      weakestSkill,
    };
  }, [analyticsData, enrichedStudents, enrichedAnalyticsQuestions]);

  const sortedAnalyticsQuestions = useMemo(() => {
    const list = enrichedAnalyticsQuestions.slice();
    if (qSort === "hardest") {
      list.sort((a, b) => {
        const accA = a.accuracy === null ? 999 : a.accuracy;
        const accB = b.accuracy === null ? 999 : b.accuracy;
        if (accA !== accB) return accA - accB;
        return a.index - b.index;
      });
    }
    return list;
  }, [enrichedAnalyticsQuestions, qSort]);

  const copyJoinCode = (code) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(""), 1600);
    }
  };

  if (!authed) {
    return (
      <div className="tp-login-wrap">
        <form className="tp-login-card" onSubmit={handleLogin}>
          <h2 className="chall-title" style={{ fontSize: "24px" }}>
            Teacher Portal
          </h2>
          <div className="chall-rule" style={{ marginBottom: "18px" }}></div>
          <input
            type="password"
            className="tp-input"
            placeholder="Teacher passcode"
            value={pwdInput}
            onChange={(e) => setPwdInput(e.target.value)}
            autoFocus
          />
          {authErr && <div className="tp-err">{authErr}</div>}
          <div className="tp-login-actions">
            <button type="button" className="hw-action-btn ghost" onClick={onExit}>
              Back
            </button>
            <button type="submit" className="hw-action-btn primary">
              Continue
            </button>
          </div>
        </form>
      </div>
    );
  }

  const currentClass = classes.find((c) => c.id === selectedClassId) || null;

  return (
    <div className="tp-shell">
      {/* Minimalist Top Bar */}
      <header className="tp-topbar">
        <div className="tp-brand">
          <span className="tp-brand-title">Teacher</span>
          <div className="tp-class-pills">
            {classes.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`tp-class-tab ${c.id === selectedClassId ? "active" : ""}`}
                onClick={() => {
                  setSelectedClassId(c.id);
                  setSubView("overview");
                }}
              >
                {c.name}
              </button>
            ))}
            {creatingClass ? (
              <form className="tp-inline-class-form" onSubmit={handleCreateClass}>
                <input
                  type="text"
                  className="tp-inline-input"
                  placeholder="Class name..."
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="tp-pill-btn dark">
                  Add
                </button>
                <button
                  type="button"
                  className="tp-pill-btn"
                  onClick={() => setCreatingClass(false)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="tp-class-tab add"
                onClick={() => setCreatingClass(true)}
              >
                + New Class
              </button>
            )}
          </div>
        </div>

        <div className="tp-top-actions">
          <button type="button" className="tp-pill-btn" onClick={onExit}>
            Exam View
          </button>
          <button
            type="button"
            className="tp-pill-btn"
            onClick={() => {
              sessionStorage.removeItem("satbank:teacherKey");
              setTeacherKey("");
              setAuthed(false);
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="tp-main">
        {!currentClass ? (
          <div className="tp-empty-state">
            <h3>Create your first class</h3>
            <p>Students will join using a 6-character class code.</p>
            <form className="tp-first-class-form" onSubmit={handleCreateClass}>
              <input
                type="text"
                className="tp-input"
                placeholder="Class name (e.g. Period 3 SAT)"
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
              />
              <button type="submit" className="hw-action-btn primary">
                Create Class
              </button>
            </form>
          </div>
        ) : (
          <div className="tp-workspace">
            {/* Class Header Strip */}
            <div className="tp-class-header">
              <div className="tp-class-meta">
                <h1 className="tp-class-h1">{currentClass.name}</h1>
                <button
                  type="button"
                  className="tp-code-chip"
                  onClick={() => copyJoinCode(currentClass.join_code)}
                  title="Click to copy join code"
                >
                  <span>Code:</span>
                  <strong>{currentClass.join_code}</strong>
                  <small>{copiedCode === currentClass.join_code ? "Copied" : "Copy"}</small>
                </button>
              </div>

              <div className="tp-header-actions">
                {subView !== "overview" ? (
                  <button
                    type="button"
                    className="hw-action-btn ghost"
                    onClick={() => setSubView("overview")}
                  >
                    Back to Class
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="tp-text-danger"
                      onClick={() => handleDeleteClass(currentClass.id)}
                    >
                      Delete Class
                    </button>
                    <button
                      type="button"
                      className="hw-action-btn primary"
                      onClick={() => {
                        setCreateMsg(null);
                        setSubView("new-assignment");
                      }}
                    >
                      + New Assignment
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* SUBVIEW 1: CLASS OVERVIEW (ASSIGNMENTS + STUDENTS) */}
            {subView === "overview" && (
              <div className="tp-overview-stack">
                <section className="tp-section">
                  <div className="tp-sec-label">
                    Assignments ({classAssignments.length})
                  </div>
                  {classAssignments.length === 0 ? (
                    <div className="tp-empty-box">
                      No assignments yet. Click <strong>+ New Assignment</strong> to assign practice questions.
                    </div>
                  ) : (
                    <div className="tp-assign-list">
                      {classAssignments.map((a, idx) => (
                        <div
                          key={a.id}
                          className="tp-assign-card"
                          style={{ animationDelay: `${Math.min(idx * 35, 180)}ms` }}
                        >
                          <div className="tp-assign-info">
                            <div className="tp-assign-title">{a.title}</div>
                            <div className="tp-assign-sub">
                              <span>{(a.question_ids || []).length} questions</span>
                              {a.domain_filter && <span>· {a.domain_filter}</span>}
                              {a.difficulty_filter && <span>· {a.difficulty_filter}</span>}
                              {a.due_at && (
                                <span>
                                  · Due{" "}
                                  {new Date(a.due_at).toLocaleDateString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                  })}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="tp-assign-right">
                            <div className="tp-completion-pill">
                              <strong>{a.completed_count}</strong> / {a.student_count} done
                            </div>
                            <button
                              type="button"
                              className="hw-action-btn ghost"
                              onClick={() => openAnalytics(a.id)}
                            >
                              Analysis
                            </button>
                            <button
                              type="button"
                              className="tp-icon-del"
                              title="Delete assignment"
                              onClick={() => handleDeleteAssignment(a.id)}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="tp-section">
                  <div className="tp-sec-label">
                    Students ({classStudents.length})
                  </div>
                  {classStudents.length === 0 ? (
                    <div className="tp-empty-box">
                      No students enrolled yet. Share code{" "}
                      <strong>{currentClass.join_code}</strong> with your students.
                    </div>
                  ) : (
                    <div className="tp-roster-card">
                      <table className="tp-clean-table">
                        <thead>
                          <tr>
                            <th>Student</th>
                            <th>Completed</th>
                            <th>Average Score</th>
                            <th>Tries</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {classStudents.map((s) => (
                            <tr key={s.name}>
                              <td>
                                <span className={`tp-dot ${s.online ? "on" : ""}`}></span>
                                <strong>{s.name}</strong>
                              </td>
                              <td>
                                {s.completedAssignments} / {s.totalAssignments}
                              </td>
                              <td>{s.avgScorePct !== null ? `${s.avgScorePct}%` : "–"}</td>
                              <td>{s.totalAttempts}</td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  type="button"
                                  className="tp-icon-del"
                                  title="Remove student"
                                  onClick={() => handleRemoveStudent(s.name)}
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* SUBVIEW 2: CREATE NEW ASSIGNMENT */}
            {subView === "new-assignment" && (
              <form className="tp-builder-card" onSubmit={handleCreateAssignment}>
                <div className="tp-builder-row">
                  <div className="tp-field" style={{ flex: 2 }}>
                    <label>Assignment Title</label>
                    <input
                      type="text"
                      className="tp-input"
                      placeholder="e.g. Craft & Structure Practice"
                      value={assignTitle}
                      onChange={(e) => setAssignTitle(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="tp-field" style={{ flex: 1 }}>
                    <label>Due Date (Optional)</label>
                    <input
                      type="datetime-local"
                      className="tp-input"
                      value={assignDue}
                      onChange={(e) => setAssignDue(e.target.value)}
                    />
                  </div>
                </div>

                <div className="hw-seg" style={{ maxWidth: "360px", margin: "18px 0" }}>
                  <button
                    type="button"
                    className={pickMode === "filter" ? "sel" : ""}
                    onClick={() => setPickMode("filter")}
                  >
                    Auto-Pick
                  </button>
                  <button
                    type="button"
                    className={pickMode === "manual" ? "sel" : ""}
                    onClick={() => setPickMode("manual")}
                  >
                    Hand-Pick ({selectedQIds.length})
                  </button>
                </div>

                {pickMode === "filter" ? (
                  <div className="tp-auto-pane">
                    <div className="tp-builder-row">
                      <div className="tp-field">
                        <label>Category</label>
                        <select
                          className="tp-select"
                          value={filterDomain}
                          onChange={(e) => setFilterDomain(e.target.value)}
                        >
                          <option value="All">All Categories</option>
                          {DOMAINS.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="tp-field">
                        <label>Difficulty</label>
                        <select
                          className="tp-select"
                          value={filterDiff}
                          onChange={(e) => setFilterDiff(e.target.value)}
                        >
                          <option value="All">All Difficulties</option>
                          {DIFFICULTIES.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="tp-field" style={{ marginTop: "16px" }}>
                      <label>Number of Questions</label>
                      <div className="tp-count-row">
                        <div className="hw-seg" style={{ flex: 1, margin: 0 }}>
                          {COUNT_PRESETS.map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={Number(filterCount) === n ? "sel" : ""}
                              onClick={() => setFilterCount(n)}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          className="tp-input tp-count-custom"
                          value={filterCount}
                          onChange={(e) => setFilterCount(e.target.value)}
                        />
                      </div>
                      <div className="tp-pool-hint">
                        {matchingAutoPool.length} matching questions available in bank
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="tp-manual-pane">
                    <div className="tp-browser-filters">
                      <input
                        type="text"
                        className="tp-input"
                        placeholder="Search by keyword, skill, or ID..."
                        value={qSearch}
                        onChange={(e) => {
                          setQSearch(e.target.value);
                          setQPage(1);
                        }}
                      />
                      <select
                        className="tp-select"
                        value={qDomain}
                        onChange={(e) => {
                          setQDomain(e.target.value);
                          setQPage(1);
                        }}
                      >
                        <option value="All">All Categories</option>
                        {DOMAINS.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                      <select
                        className="tp-select"
                        value={qDiff}
                        onChange={(e) => {
                          setQDiff(e.target.value);
                          setQPage(1);
                        }}
                      >
                        <option value="All">All Difficulties</option>
                        {DIFFICULTIES.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedQIds.length > 0 && (
                      <div className="tp-selected-bar">
                        <span>
                          <strong>{selectedQIds.length}</strong> selected
                        </span>
                        <button
                          type="button"
                          className="tp-pill-btn"
                          onClick={() => setSelectedQIds([])}
                        >
                          Clear
                        </button>
                      </div>
                    )}

                    <div className="tp-q-list">
                      {currentManualSlice.length === 0 ? (
                        <div className="tp-empty-box">No matching questions found.</div>
                      ) : (
                        currentManualSlice.map((q) => {
                          const checked = selectedQIds.includes(q.id);
                          const expanded = expandedQId === q.id;
                          return (
                            <div
                              key={q.id}
                              className={`tp-q-item ${checked ? "checked" : ""}`}
                            >
                              <div className="tp-q-row">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleSelectQ(q.id)}
                                />
                                <div
                                  className="tp-q-main"
                                  onClick={() => toggleSelectQ(q.id)}
                                >
                                  <div className="tp-q-meta">
                                    <span className="tp-q-id">{q.id}</span>
                                    <span>{q.domain}</span>
                                    <span>· {q.skill}</span>
                                    <span className="tp-dif-tag">{q.difficulty}</span>
                                  </div>
                                  <div className="tp-q-snippet">
                                    {(q.question || "").slice(0, 175)}
                                    {(q.question || "").length > 175 ? "..." : ""}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="tp-pill-btn"
                                  onClick={() =>
                                    setExpandedQId(expanded ? null : q.id)
                                  }
                                >
                                  {expanded ? "Hide" : "Show"}
                                </button>
                              </div>

                              {expanded && (
                                <div className="tp-q-preview">
                                  <div className="tp-q-fulltext">{q.question}</div>
                                  {q.choices && (
                                    <div className="tp-q-choices">
                                      {["A", "B", "C", "D"].map((k) => (
                                        <div
                                          key={k}
                                          className={`tp-q-choice ${
                                            q.correct === k ? "correct" : ""
                                          }`}
                                        >
                                          <strong>{k}.</strong> {q.choices[k]}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="tp-pagination">
                      <button
                        type="button"
                        className="tp-pill-btn"
                        disabled={qPage <= 1}
                        onClick={() => setQPage((p) => Math.max(1, p - 1))}
                      >
                        Prev
                      </button>
                      <span>
                        Page {qPage} of {totalManualPages} ({filteredManualQuestions.length})
                      </span>
                      <button
                        type="button"
                        className="tp-pill-btn"
                        disabled={qPage >= totalManualPages}
                        onClick={() => setQPage((p) => p + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}

                {createMsg && (
                  <div className={`hw-status-msg ${createMsg.ok ? "ok" : "err"}`}>
                    {createMsg.text}
                  </div>
                )}

                <div className="tp-builder-footer">
                  <button
                    type="button"
                    className="hw-action-btn ghost"
                    onClick={() => setSubView("overview")}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="hw-action-btn primary"
                    disabled={creatingAssign}
                  >
                    {creatingAssign ? "Creating..." : "Create Assignment"}
                  </button>
                </div>
              </form>
            )}

            {/* SUBVIEW 3: DETAILED GRADEBOOK & QUESTION ANALYSIS */}
            {subView === "gradebook" && (
              <div className="tp-gradebook-card">
                {analyticsLoading || !analyticsData ? (
                  <div className="tp-empty-box">Loading analysis...</div>
                ) : (
                  <>
                    <div className="tp-gb-head">
                      <div>
                        <h2 className="tp-gb-title">{analyticsData.assignment.title}</h2>
                        <div className="tp-assign-sub">
                          {(analyticsData.assignment.question_ids || []).length} questions
                        </div>
                      </div>
                      <div className="hw-seg" style={{ width: "280px", margin: 0 }}>
                        <button
                          type="button"
                          className={analyticsTab === "questions" ? "sel" : ""}
                          onClick={() => setAnalyticsTab("questions")}
                        >
                          Questions
                        </button>
                        <button
                          type="button"
                          className={analyticsTab === "students" ? "sel" : ""}
                          onClick={() => setAnalyticsTab("students")}
                        >
                          Students
                        </button>
                      </div>
                    </div>

                    {/* Top KPI Strip */}
                    {analyticsKpis && (
                      <div className="tp-kpi-grid">
                        <div className="tp-kpi-box">
                          <div className="tp-kpi-label">Completion</div>
                          <div className="tp-kpi-val">
                            {analyticsKpis.completedCount} / {analyticsKpis.totalStudents}
                          </div>
                          <div className="tp-kpi-sub">students submitted</div>
                        </div>

                        <div className="tp-kpi-box">
                          <div className="tp-kpi-label">Class Average</div>
                          <div className="tp-kpi-val">
                            {analyticsKpis.avgBestPct !== null
                              ? `${analyticsKpis.avgBestPct}%`
                              : "–"}
                          </div>
                          <div className="tp-kpi-sub">
                            {analyticsKpis.avgFirstPct !== null
                              ? `First try avg: ${analyticsKpis.avgFirstPct}%`
                              : "No submissions yet"}
                          </div>
                        </div>

                        <div className="tp-kpi-box">
                          <div className="tp-kpi-label">Hardest Question</div>
                          <div className="tp-kpi-val">
                            {analyticsKpis.hardestQ
                              ? `Q${analyticsKpis.hardestQ.index} (${analyticsKpis.hardestQ.accuracy}%)`
                              : "–"}
                          </div>
                          <div className="tp-kpi-sub">
                            {analyticsKpis.hardestQ
                              ? analyticsKpis.hardestQ.skill || analyticsKpis.hardestQ.domain
                              : "Awaiting attempts"}
                          </div>
                        </div>

                        <div className="tp-kpi-box">
                          <div className="tp-kpi-label">Weakest Skill</div>
                          <div className="tp-kpi-val" style={{ fontSize: "15px" }}>
                            {analyticsKpis.weakestSkill
                              ? analyticsKpis.weakestSkill.skill
                              : "–"}
                          </div>
                          <div className="tp-kpi-sub">
                            {analyticsKpis.weakestSkill
                              ? `${analyticsKpis.weakestSkill.pct}% accuracy`
                              : "Awaiting attempts"}
                          </div>
                        </div>
                      </div>
                    )}

                    {analyticsTab === "questions" ? (
                      <div className="tp-qa-section">
                        {/* Sort Bar */}
                        <div className="tp-qa-toolbar">
                          <span className="tp-sec-label" style={{ margin: 0 }}>
                            Question Breakdown
                          </span>
                          <div className="tp-sort-pills">
                            <button
                              type="button"
                              className={`tp-sort-btn ${qSort === "order" ? "on" : ""}`}
                              onClick={() => setQSort("order")}
                            >
                              In Order
                            </button>
                            <button
                              type="button"
                              className={`tp-sort-btn ${qSort === "hardest" ? "on" : ""}`}
                              onClick={() => setQSort("hardest")}
                            >
                              Hardest First
                            </button>
                          </div>
                        </div>

                        <div className="tp-qa-list">
                          {sortedAnalyticsQuestions.map((q) => {
                            const isOpen = expandedAnalyticsQId === q.id;
                            const accColor =
                              q.accuracy === null
                                ? "neutral"
                                : q.accuracy >= 75
                                ? "good"
                                : q.accuracy >= 50
                                ? "mid"
                                : "low";

                            return (
                              <div
                                key={q.id}
                                className={`tp-qa-card ${isOpen ? "open" : ""}`}
                              >
                                <div
                                  className="tp-qa-summary"
                                  onClick={() =>
                                    setExpandedAnalyticsQId(isOpen ? null : q.id)
                                  }
                                >
                                  <div className="tp-qa-num">{q.index}</div>

                                  <div className="tp-qa-main">
                                    <div className="tp-qa-tags">
                                      <span className="tp-qa-domain">{q.domain}</span>
                                      {q.skill && <span>· {q.skill}</span>}
                                      {q.difficulty && (
                                        <span className="tp-dif-tag">{q.difficulty}</span>
                                      )}
                                      {q.trapChoice && (
                                        <span className="tp-trap-tag">
                                          Common wrong: {q.trapChoice.letter} ({q.trapChoice.count})
                                        </span>
                                      )}
                                    </div>
                                    <div className="tp-qa-snippet">
                                      {q.question
                                        ? q.question.length > 155
                                          ? q.question.slice(0, 155) + "..."
                                          : q.question
                                        : `Question ${q.id}`}
                                    </div>
                                  </div>

                                  <div className="tp-qa-right">
                                    <div className="tp-qa-acc-col">
                                      <div className={`tp-qa-acc-val ${accColor}`}>
                                        {q.accuracy !== null ? `${q.accuracy}%` : "No tries"}
                                      </div>
                                      <div className="tp-qa-acc-sub">
                                        {q.attempted > 0
                                          ? `${q.correctCount}/${q.attempted} correct`
                                          : `Ans: ${q.correct || "–"}`}
                                      </div>
                                    </div>

                                    <button
                                      type="button"
                                      className="tp-pill-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setExpandedAnalyticsQId(isOpen ? null : q.id);
                                      }}
                                    >
                                      {isOpen ? "Hide" : "Show"}
                                    </button>
                                  </div>
                                </div>

                                {isOpen && (
                                  <div className="tp-qa-detail">
                                    <div className="tp-q-fulltext">{q.question}</div>

                                    <div className="tp-qa-choices">
                                      {["A", "B", "C", "D"].map((letter) => {
                                        const isCorrect =
                                          String(q.correct).toUpperCase() === letter;
                                        const count = q.choiceCounts[letter] || 0;
                                        const pct =
                                          q.attempted > 0
                                            ? Math.round((count / q.attempted) * 100)
                                            : 0;
                                        const studentsWhoPicked =
                                          q.pickedBy[letter] || [];

                                        return (
                                          <div
                                            key={letter}
                                            className={`tp-qa-choice-row ${
                                              isCorrect
                                                ? "correct"
                                                : count > 0
                                                ? "wrong-picked"
                                                : ""
                                            }`}
                                          >
                                            <div className="tp-qa-choice-top">
                                              <div className="tp-qa-choice-text">
                                                <span className="tp-qa-letter">
                                                  {letter}
                                                </span>
                                                <span>
                                                  {(q.choices && q.choices[letter]) || ""}
                                                </span>
                                              </div>
                                              <div className="tp-qa-choice-stat">
                                                {isCorrect && (
                                                  <span className="tp-correct-pill">
                                                    Correct
                                                  </span>
                                                )}
                                                <strong>{pct}%</strong>
                                                <span>({count})</span>
                                              </div>
                                            </div>

                                            {/* Choice distribution bar */}
                                            <div className="tp-qa-bar-track">
                                              <div
                                                className="tp-qa-bar-fill"
                                                style={{ width: `${pct}%` }}
                                              ></div>
                                            </div>

                                            {/* Show exact students who picked this option */}
                                            {studentsWhoPicked.length > 0 && (
                                              <div className="tp-qa-picked-names">
                                                Picked by: {studentsWhoPicked.join(", ")}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>

                                    {q.rationale && (
                                      <div className="tp-qa-rationale">
                                        <strong>Explanation:</strong> {q.rationale}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <>
                        <table className="tp-clean-table">
                          <thead>
                            <tr>
                              <th>Student</th>
                              <th>Status</th>
                              <th>Best Score</th>
                              <th>First Try</th>
                              <th>Tries</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {enrichedStudents.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="tp-empty-box">
                                  No students in this class yet.
                                </td>
                              </tr>
                            ) : (
                              enrichedStudents.map((st) => (
                                <tr key={st.name}>
                                  <td>
                                    <strong>{st.name}</strong>
                                  </td>
                                  <td>
                                    {!st.completed ? (
                                      <span className="tp-badge pending">Pending</span>
                                    ) : st.isLate ? (
                                      <span className="tp-badge late">Late</span>
                                    ) : (
                                      <span className="tp-badge ok">Completed</span>
                                    )}
                                  </td>
                                  <td>
                                    {st.completed ? (
                                      <strong>
                                        {st.bestScore}/{st.total} ({st.bestPct}%)
                                      </strong>
                                    ) : (
                                      "–"
                                    )}
                                  </td>
                                  <td>
                                    {st.completed ? `${st.firstScore}/${st.total}` : "–"}
                                  </td>
                                  <td>{st.attemptsCount || "–"}</td>
                                  <td style={{ textAlign: "right" }}>
                                    {st.completed && (
                                      <button
                                        type="button"
                                        className="tp-pill-btn"
                                        onClick={() =>
                                          setInspectStudent(
                                            inspectStudent?.name === st.name ? null : st
                                          )
                                        }
                                      >
                                        {inspectStudent?.name === st.name
                                          ? "Hide"
                                          : "Answers"}
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>

                        {inspectStudent && (
                          <div className="tp-student-inspect">
                            <div className="tp-sec-label">
                              {inspectStudent.name} — Question Breakdown (Click any question to view)
                            </div>
                            <div className="hw-sum-grid">
                              {enrichedAnalyticsQuestions.map((q) => {
                                const ans = (inspectStudent.bestAnswers || {})[q.id];
                                const isOk = ans && ans === q.correct;
                                return (
                                  <button
                                    key={q.id}
                                    type="button"
                                    className={`hw-q-pill ${
                                      isOk ? "ok" : ans ? "bad" : "skip"
                                    }`}
                                    onClick={() => {
                                      setAnalyticsTab("questions");
                                      setExpandedAnalyticsQId(q.id);
                                    }}
                                  >
                                    <span>Q{q.index}</span>
                                    <small>
                                      {ans || "–"} ({q.correct})
                                    </small>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
