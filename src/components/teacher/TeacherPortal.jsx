import React, { useState, useEffect, useCallback } from "react";
import { hwFetch } from "../../utils/homeworkApi";

const DOMAINS = [
  "Information and Ideas",
  "Craft and Structure",
  "Expression of Ideas",
  "Standard English Conventions",
];
const DIFFICULTIES = ["Easy", "Medium", "Hard"];

export default function TeacherPortal({ onExit }) {
  const [teacherKey, setTeacherKey] = useState(
    () => sessionStorage.getItem("satbank:teacherKey") || ""
  );
  const [authed, setAuthed] = useState(false);
  const [pwdInput, setPwdInput] = useState("");
  const [authErr, setAuthErr] = useState("");

  const [activeNav, setActiveNav] = useState("classes"); // "classes" | "create" | "gradebook"
  const [classes, setClasses] = useState([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [classStudents, setClassStudents] = useState([]);
  const [classAssignments, setClassAssignments] = useState([]);
  const [newClassName, setNewClassName] = useState("");
  const [copiedCode, setCopiedCode] = useState("");

  // Create Assignment state
  const [assignClassId, setAssignClassId] = useState("");
  const [assignTitle, setAssignTitle] = useState("");
  const [assignDue, setAssignDue] = useState("");
  const [pickMode, setPickMode] = useState("filter"); // "filter" | "manual"
  const [filterDomain, setFilterDomain] = useState("All");
  const [filterDiff, setFilterDiff] = useState("All");
  const [filterCount, setFilterCount] = useState(10);

  // Manual Question Picker state
  const [qSearch, setQSearch] = useState("");
  const [qDomain, setQDomain] = useState("All");
  const [qDiff, setQDiff] = useState("All");
  const [qPage, setQPage] = useState(1);
  const [qData, setQData] = useState({ questions: [], total: 0, totalPages: 1 });
  const [qLoading, setQLoading] = useState(false);
  const [selectedQIds, setSelectedQIds] = useState([]);
  const [expandedQId, setExpandedQId] = useState(null);
  const [createMsg, setCreateMsg] = useState(null);

  // Gradebook Analytics state
  const [analyticsAssignmentId, setAnalyticsAssignmentId] = useState("");
  const [analyticsData, setAnalyticsData] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsTab, setAnalyticsTab] = useState("students"); // "students" | "questions"
  const [inspectStudent, setInspectStudent] = useState(null);

  const tFetch = useCallback(
    (path, opts = {}) => {
      return hwFetch(path, {
        ...opts,
        headers: {
          "x-teacher-key": teacherKey,
          ...(opts.headers || {}),
        },
      });
    },
    [teacherKey]
  );

  // Verify stored teacherKey on mount
  useEffect(() => {
    if (!teacherKey) return;
    tFetch("/api/teacher/classes").then((res) => {
      if (res && res.ok) {
        setAuthed(true);
        setClasses(res.classes || []);
        if (res.classes && res.classes.length && !selectedClassId) {
          setSelectedClassId(res.classes[0].id);
          setAssignClassId(res.classes[0].id);
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
      setAuthErr("Invalid teacher passcode.");
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
      if (list.length > 0 && !assignClassId) {
        setAssignClassId(list[0].id);
      }
    }
  }, [tFetch, selectedClassId, assignClassId]);

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

  // Question Bank search for Manual Picker
  const loadQuestions = useCallback(async () => {
    if (!authed || activeNav !== "create" || pickMode !== "manual") return;
    setQLoading(true);
    const params = new URLSearchParams({
      q: qSearch,
      domain: qDomain === "All" ? "" : qDomain,
      difficulty: qDiff === "All" ? "" : qDiff,
      page: String(qPage),
      limit: "20",
    });
    const res = await tFetch(`/api/teacher/questions?${params.toString()}`);
    setQLoading(false);
    if (res && res.ok) {
      setQData({
        questions: res.questions || [],
        total: res.total || 0,
        totalPages: res.totalPages || 1,
      });
    }
  }, [authed, activeNav, pickMode, qSearch, qDomain, qDiff, qPage, tFetch]);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  // Load Analytics when analyticsAssignmentId changes
  const openAnalytics = async (assignmentId) => {
    setAnalyticsAssignmentId(assignmentId);
    setActiveNav("gradebook");
    setAnalyticsLoading(true);
    setInspectStudent(null);
    const res = await tFetch(`/api/teacher/assignments/${encodeURIComponent(assignmentId)}/analytics`);
    setAnalyticsLoading(false);
    if (res && res.ok) {
      setAnalyticsData(res);
    }
  };

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
      await loadClasses();
      setSelectedClassId(res.class.id);
      setAssignClassId(res.class.id);
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
    const targetClass = assignClassId || selectedClassId;
    if (!targetClass) {
      setCreateMsg({ ok: false, text: "Create or select a class first." });
      return;
    }
    if (!assignTitle.trim()) {
      setCreateMsg({ ok: false, text: "Enter an assignment title." });
      return;
    }
    if (pickMode === "manual" && selectedQIds.length === 0) {
      setCreateMsg({ ok: false, text: "Select at least one question from the bank." });
      return;
    }

    const body = {
      title: assignTitle.trim(),
      due_at: assignDue ? new Date(assignDue).toISOString() : null,
      domain: pickMode === "filter" ? filterDomain : null,
      difficulty: pickMode === "filter" ? filterDiff : null,
      count: pickMode === "filter" ? Number(filterCount) || 10 : selectedQIds.length,
      question_ids: pickMode === "manual" ? selectedQIds : [],
    };

    const res = await tFetch(`/api/teacher/classes/${encodeURIComponent(targetClass)}/assignments`, {
      method: "POST",
      body,
    });

    if (res && res.ok) {
      setAssignTitle("");
      setAssignDue("");
      setSelectedQIds([]);
      setCreateMsg({
        ok: true,
        text: `Created "${res.assignment.title}" (${res.assignment.question_ids.length} questions).`,
      });
      loadClasses();
      loadClassDetails(targetClass);
    } else {
      setCreateMsg({
        ok: false,
        text:
          res?.error === "no-matching-questions"
            ? "No questions match those filters."
            : "Could not create assignment.",
      });
    }
  };

  const handleDeleteAssignment = async (aid) => {
    if (!window.confirm("Delete this assignment and all student submissions?")) return;
    const res = await tFetch(`/api/teacher/assignments/${encodeURIComponent(aid)}`, {
      method: "DELETE",
    });
    if (res && res.ok) {
      if (analyticsAssignmentId === aid) {
        setAnalyticsAssignmentId("");
        setAnalyticsData(null);
      }
      loadClasses();
      loadClassDetails(selectedClassId);
    }
  };

  const copyJoinCode = (code) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(""), 1800);
    }
  };

  if (!authed) {
    return (
      <div className="tp-login-wrap">
        <form className="tp-login-card" onSubmit={handleLogin}>
          <div className="tp-login-title">Teacher Portal</div>
          <input
            type="password"
            className="tp-input"
            placeholder="Enter teacher passcode"
            value={pwdInput}
            onChange={(e) => setPwdInput(e.target.value)}
            autoFocus
          />
          {authErr && <div className="tp-err">{authErr}</div>}
          <div className="tp-login-actions">
            <button type="button" className="btn-ghost" onClick={onExit}>
              Back to Exam
            </button>
            <button type="submit" className="btn-blue">
              Enter Portal
            </button>
          </div>
        </form>
      </div>
    );
  }

  const currentClass = classes.find((c) => c.id === selectedClassId) || null;

  return (
    <div className="tp-shell">
      <header className="tp-topbar">
        <div className="tp-brand">
          <span className="tp-brand-title">SAT Teacher Portal</span>
          <div className="tp-nav">
            <button
              type="button"
              className={activeNav === "classes" ? "active" : ""}
              onClick={() => setActiveNav("classes")}
            >
              Classes & Assignments
            </button>
            <button
              type="button"
              className={activeNav === "create" ? "active" : ""}
              onClick={() => setActiveNav("create")}
            >
              Create Homework
            </button>
            <button
              type="button"
              className={activeNav === "gradebook" ? "active" : ""}
              onClick={() => {
                setActiveNav("gradebook");
                if (!analyticsAssignmentId && classAssignments.length > 0) {
                  openAnalytics(classAssignments[0].id);
                }
              }}
            >
              Gradebook & Analytics
            </button>
          </div>
        </div>
        <div className="tp-top-actions">
          <button type="button" className="btn-ghost" onClick={onExit}>
            Student View
          </button>
          <button
            type="button"
            className="btn-ghost"
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
        {/* TAB 1: CLASSES, ROSTERS & ASSIGNMENTS */}
        {activeNav === "classes" && (
          <div className="tp-grid-layout">
            {/* Left Sidebar: Classes List */}
            <aside className="tp-sidebar-card">
              <div className="tp-sec-head">Classes</div>
              <form className="tp-create-class-form" onSubmit={handleCreateClass}>
                <input
                  type="text"
                  className="tp-input"
                  placeholder="New class name (e.g. Period 2)"
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                />
                <button type="submit" className="btn-blue">
                  Create
                </button>
              </form>

              <div className="tp-class-list">
                {classes.length === 0 ? (
                  <div className="tp-empty">No classes yet. Create one above.</div>
                ) : (
                  classes.map((c) => (
                    <div
                      key={c.id}
                      className={`tp-class-item ${c.id === selectedClassId ? "sel" : ""}`}
                      onClick={() => {
                        setSelectedClassId(c.id);
                        setAssignClassId(c.id);
                      }}
                    >
                      <div>
                        <div className="tp-class-name">{c.name}</div>
                        <div className="tp-class-sub">
                          {c.student_count} students · {c.assignment_count} assignments
                        </div>
                      </div>
                      <span className="tp-code-badge">{c.join_code}</span>
                    </div>
                  ))
                )}
              </div>
            </aside>

            {/* Right Content: Selected Class Roster & Assignments */}
            <section className="tp-content-col">
              {!currentClass ? (
                <div className="tp-card tp-empty">Select or create a class to manage homework.</div>
              ) : (
                <>
                  <div className="tp-card tp-class-banner">
                    <div>
                      <h2 className="tp-h2">{currentClass.name}</h2>
                      <div className="tp-join-line">
                        <span>Student Join Code:</span>
                        <strong className="tp-join-code-lg">{currentClass.join_code}</strong>
                        <button
                          type="button"
                          className="tp-btn-sm"
                          onClick={() => copyJoinCode(currentClass.join_code)}
                        >
                          {copiedCode === currentClass.join_code ? "Copied" : "Copy Code"}
                        </button>
                      </div>
                    </div>
                    <div className="tp-banner-btns">
                      <button
                        type="button"
                        className="btn-blue"
                        onClick={() => {
                          setAssignClassId(currentClass.id);
                          setActiveNav("create");
                        }}
                      >
                        New Assignment
                      </button>
                      <button
                        type="button"
                        className="tp-btn-danger"
                        onClick={() => handleDeleteClass(currentClass.id)}
                      >
                        Delete Class
                      </button>
                    </div>
                  </div>

                  {/* Assignments for this Class */}
                  <div className="tp-card">
                    <div className="tp-sec-head">
                      Assignments ({classAssignments.length})
                    </div>
                    {classAssignments.length === 0 ? (
                      <div className="tp-empty">
                        No homework assigned to this class yet.
                      </div>
                    ) : (
                      <table className="tp-table">
                        <thead>
                          <tr>
                            <th>Title</th>
                            <th>Questions</th>
                            <th>Due Date</th>
                            <th>Completed</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {classAssignments.map((a) => (
                            <tr key={a.id}>
                              <td>
                                <strong>{a.title}</strong>
                                {(a.domain_filter || a.difficulty_filter) && (
                                  <div className="tp-row-sub">
                                    {[a.domain_filter, a.difficulty_filter]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </div>
                                )}
                              </td>
                              <td>{(a.question_ids || []).length} Qs</td>
                              <td>
                                {a.due_at
                                  ? new Date(a.due_at).toLocaleString(undefined, {
                                      month: "short",
                                      day: "numeric",
                                      hour: "numeric",
                                      minute: "2-digit",
                                    })
                                  : "No deadline"}
                              </td>
                              <td>
                                {a.completed_count} / {a.student_count} students
                              </td>
                              <td>
                                <div className="tp-row-actions">
                                  <button
                                    type="button"
                                    className="tp-btn-sm primary"
                                    onClick={() => openAnalytics(a.id)}
                                  >
                                    Gradebook
                                  </button>
                                  <button
                                    type="button"
                                    className="tp-btn-sm danger"
                                    onClick={() => handleDeleteAssignment(a.id)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Enrolled Students Roster */}
                  <div className="tp-card">
                    <div className="tp-sec-head">
                      Enrolled Students ({classStudents.length})
                    </div>
                    {classStudents.length === 0 ? (
                      <div className="tp-empty">
                        No students have joined yet. Share code{" "}
                        <strong>{currentClass.join_code}</strong> with your class.
                      </div>
                    ) : (
                      <table className="tp-table">
                        <thead>
                          <tr>
                            <th>Student</th>
                            <th>Status</th>
                            <th>Homework Completed</th>
                            <th>Avg Best Score</th>
                            <th>Total Attempts</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {classStudents.map((s) => (
                            <tr key={s.name}>
                              <td>
                                <strong>{s.name}</strong>
                              </td>
                              <td>
                                <span className={`tp-dot ${s.online ? "on" : ""}`}></span>
                                {s.online ? "Online" : "Offline"}
                              </td>
                              <td>
                                {s.completedAssignments} / {s.totalAssignments}
                              </td>
                              <td>{s.avgScorePct !== null ? `${s.avgScorePct}%` : "–"}</td>
                              <td>{s.totalAttempts}</td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  type="button"
                                  className="tp-btn-sm danger"
                                  onClick={() => handleRemoveStudent(s.name)}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        )}

        {/* TAB 2: CREATE HOMEWORK ASSIGNMENT */}
        {activeNav === "create" && (
          <div className="tp-create-wrap">
            <form className="tp-card tp-create-form" onSubmit={handleCreateAssignment}>
              <h2 className="tp-h2">Create Homework Assignment</h2>

              <div className="tp-form-grid">
                <div className="tp-field">
                  <label>Class</label>
                  <select
                    className="tp-select"
                    value={assignClassId}
                    onChange={(e) => setAssignClassId(e.target.value)}
                  >
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.join_code})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="tp-field">
                  <label>Assignment Title</label>
                  <input
                    type="text"
                    className="tp-input"
                    placeholder="e.g. Week 4 Craft & Structure Practice"
                    value={assignTitle}
                    onChange={(e) => setAssignTitle(e.target.value)}
                  />
                </div>

                <div className="tp-field">
                  <label>Due Date (Optional)</label>
                  <input
                    type="datetime-local"
                    className="tp-input"
                    value={assignDue}
                    onChange={(e) => setAssignDue(e.target.value)}
                  />
                </div>
              </div>

              <div className="tp-field" style={{ marginTop: "16px" }}>
                <label>Question Selection Method</label>
                <div className="chall-pick" style={{ maxWidth: "420px" }}>
                  <button
                    type="button"
                    className={pickMode === "filter" ? "sel" : ""}
                    onClick={() => setPickMode("filter")}
                  >
                    Auto-Generate by Filter
                  </button>
                  <button
                    type="button"
                    className={pickMode === "manual" ? "sel" : ""}
                    onClick={() => setPickMode("manual")}
                  >
                    Hand-Pick Questions ({selectedQIds.length})
                  </button>
                </div>
              </div>

              {pickMode === "filter" ? (
                <div className="tp-form-grid" style={{ marginTop: "16px" }}>
                  <div className="tp-field">
                    <label>Domain</label>
                    <select
                      className="tp-select"
                      value={filterDomain}
                      onChange={(e) => setFilterDomain(e.target.value)}
                    >
                      <option value="All">All Domains</option>
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

                  <div className="tp-field">
                    <label>Number of Questions</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      className="tp-input"
                      value={filterCount}
                      onChange={(e) => setFilterCount(e.target.value)}
                    />
                  </div>
                </div>
              ) : (
                <div className="tp-manual-browser">
                  <div className="tp-browser-filters">
                    <input
                      type="text"
                      className="tp-input"
                      placeholder="Search by question text, skill, or ID..."
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
                      <option value="All">All Domains</option>
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
                        Selected: <strong>{selectedQIds.length}</strong> questions
                      </span>
                      <button
                        type="button"
                        className="tp-btn-sm"
                        onClick={() => setSelectedQIds([])}
                      >
                        Clear Selection
                      </button>
                    </div>
                  )}

                  <div className="tp-q-list">
                    {qLoading ? (
                      <div className="tp-empty">Loading questions...</div>
                    ) : qData.questions.length === 0 ? (
                      <div className="tp-empty">No matching questions found.</div>
                    ) : (
                      qData.questions.map((q) => {
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
                                  <span className={`tp-dif-tag ${q.difficulty}`}>
                                    {q.difficulty}
                                  </span>
                                </div>
                                <div className="tp-q-snippet">
                                  {(q.question || "").slice(0, 180)}
                                  {(q.question || "").length > 180 ? "..." : ""}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="tp-btn-sm"
                                onClick={() =>
                                  setExpandedQId(expanded ? null : q.id)
                                }
                              >
                                {expanded ? "Hide" : "Preview"}
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
                                {q.rationale && (
                                  <div className="tp-q-rat">
                                    <strong>Rationale (Answer {q.correct}):</strong>{" "}
                                    {q.rationale}
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
                      className="tp-btn-sm"
                      disabled={qPage <= 1}
                      onClick={() => setQPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </button>
                    <span>
                      Page {qPage} of {qData.totalPages} ({qData.total} questions)
                    </span>
                    <button
                      type="button"
                      className="tp-btn-sm"
                      disabled={qPage >= qData.totalPages}
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

              <div className="tp-form-footer">
                <button type="submit" className="btn-blue">
                  Publish Homework Assignment
                </button>
              </div>
            </form>
          </div>
        )}

        {/* TAB 3: GRADEBOOK & ANALYTICS */}
        {activeNav === "gradebook" && (
          <div className="tp-gradebook-wrap">
            <div className="tp-card tp-gb-bar">
              <div className="tp-field" style={{ flex: 1 }}>
                <label>Select Assignment</label>
                <select
                  className="tp-select"
                  value={analyticsAssignmentId}
                  onChange={(e) => openAnalytics(e.target.value)}
                >
                  <option value="">-- Choose an assignment --</option>
                  {classAssignments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.class_name}: {a.title} ({(a.question_ids || []).length} Qs)
                    </option>
                  ))}
                </select>
              </div>

              {analyticsData && (
                <div className="chall-pick" style={{ width: "340px" }}>
                  <button
                    type="button"
                    className={analyticsTab === "students" ? "sel" : ""}
                    onClick={() => setAnalyticsTab("students")}
                  >
                    Student Scores
                  </button>
                  <button
                    type="button"
                    className={analyticsTab === "questions" ? "sel" : ""}
                    onClick={() => setAnalyticsTab("questions")}
                  >
                    Question Accuracy
                  </button>
                </div>
              )}
            </div>

            {analyticsLoading ? (
              <div className="tp-card tp-empty">Loading gradebook...</div>
            ) : !analyticsData ? (
              <div className="tp-card tp-empty">
                Select an assignment above to inspect student results and question accuracy.
              </div>
            ) : analyticsTab === "students" ? (
              <div className="tp-card">
                <div className="tp-sec-head">
                  {analyticsData.assignment.title} — Student Results
                </div>
                <table className="tp-table">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Status</th>
                      <th>Best Score</th>
                      <th>First Attempt</th>
                      <th>Latest Score</th>
                      <th>Attempts</th>
                      <th>Last Submitted</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {analyticsData.students.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="tp-empty">
                          No students enrolled in this class yet.
                        </td>
                      </tr>
                    ) : (
                      analyticsData.students.map((st) => (
                        <tr key={st.name}>
                          <td>
                            <strong>{st.name}</strong>
                          </td>
                          <td>
                            {!st.completed ? (
                              <span className="tp-status pending">Not Submitted</span>
                            ) : st.isLate ? (
                              <span className="tp-status late">Completed (Late)</span>
                            ) : (
                              <span className="tp-status ok">Completed</span>
                            )}
                          </td>
                          <td>
                            {st.completed ? (
                              <strong>
                                {st.bestScore} / {st.total} ({st.bestPct}%)
                              </strong>
                            ) : (
                              "–"
                            )}
                          </td>
                          <td>
                            {st.completed ? `${st.firstScore} / ${st.total}` : "–"}
                          </td>
                          <td>
                            {st.completed ? `${st.latestScore} / ${st.total}` : "–"}
                          </td>
                          <td>{st.attemptsCount}</td>
                          <td>
                            {st.lastSubmittedAt
                              ? new Date(st.lastSubmittedAt).toLocaleString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : "–"}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {st.completed && (
                              <button
                                type="button"
                                className="tp-btn-sm"
                                onClick={() =>
                                  setInspectStudent(
                                    inspectStudent?.name === st.name ? null : st
                                  )
                                }
                              >
                                {inspectStudent?.name === st.name ? "Close" : "Inspect"}
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
                    <div className="tp-sec-head">
                      {inspectStudent.name} — Question Answers (Best Attempt)
                    </div>
                    <div className="hw-sum-grid">
                      {analyticsData.questions.map((q) => {
                        const ans = (inspectStudent.bestAnswers || {})[q.id];
                        const isOk = ans && ans === q.correct;
                        return (
                          <div
                            key={q.id}
                            className={`hw-q-pill ${
                              isOk ? "ok" : ans ? "bad" : "skip"
                            }`}
                          >
                            <span>Q{q.index}</span>
                            <small>
                              {ans || "–"} (Ans: {q.correct})
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="tp-card">
                <div className="tp-sec-head">
                  {analyticsData.assignment.title} — Per-Question Accuracy Breakdown
                </div>
                <table className="tp-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Question ID</th>
                      <th>Domain & Skill</th>
                      <th>Difficulty</th>
                      <th>Correct</th>
                      <th>Class Accuracy</th>
                      <th>Choice Distribution (A / B / C / D)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analyticsData.questions.map((q) => (
                      <tr key={q.id}>
                        <td>{q.index}</td>
                        <td>
                          <code>{q.id}</code>
                        </td>
                        <td>
                          <div>{q.domain}</div>
                          <div className="tp-row-sub">{q.skill}</div>
                        </td>
                        <td>{q.difficulty}</td>
                        <td>
                          <strong>{q.correct}</strong>
                        </td>
                        <td>
                          {q.accuracy !== null ? (
                            <strong>
                              {q.accuracy}% ({q.correctCount}/{q.attempted})
                            </strong>
                          ) : (
                            "No attempts"
                          )}
                        </td>
                        <td>
                          A: {q.choiceCounts.A} · B: {q.choiceCounts.B} · C:{" "}
                          {q.choiceCounts.C} · D: {q.choiceCounts.D}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

