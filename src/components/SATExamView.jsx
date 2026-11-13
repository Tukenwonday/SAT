import React from 'react';

export default function SATExamView() {
  return (
    <>

  <div id="loadwrap">
    <div className="spinner"></div>
    <div id="loaderr">
      <p id="loadmsg">Could not auto-load.</p>
      <p id="loadpick">Pick <b>sat_db.json</b>:
        <input type="file" id="filepick" accept=".json" />
      </p>
    </div>
  </div>

  <div id="exam" style={{ display: "none" }}>
    <header id="topbar">
      <div>
        <div id="difftag" title="Question difficulty"></div>
      </div>
      <div id="cdbox">
        <div id="cdtime">–</div>
      </div>
      <div id="topright">
        <div id="presence" title="Live study status">{/* pills rendered live, one per player */}</div>
        <div className="tool"><svg width="14" height="14" viewBox="0 0 14 14">
            <g fill="none" stroke="#111" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 1.5h4v4M12.5 1.5L8 6M5.5 12.5h-4v-4M1.5 12.5L6 8" />
            </g>
          </svg><br /><span id="zoomval">100%</span></div>
        <button className="tool" id="hlbtn" title="Toggle auto-highlight: select text to highlight instantly"><span><svg
              width="18" height="18" viewBox="0 0 20 20">
              <g fill="none" stroke="#111" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.5 3.5l3 3L8 15l-4 1 1-4z" />
                <path d="M12 5l3 3" />
              </g>
            </svg></span><br />Highlight</button>
        <button className="tool" id="homeworkbtn" title="Class Homework & Assignments" style={{ position: "relative" }}><span><svg width="17" height="17"
              viewBox="0 0 18 18">
              <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="2.5" width="11" height="13" rx="1.8" />
                <path d="M6.5 6.5h5" />
                <path d="M6.5 9.5h5" />
                <path d="M6.5 12.5h3" />
              </g>
            </svg></span><span id="hw-badge" className="hw-top-badge" style={{ display: "none" }}>0</span><br />Homework</button>
        <button className="tool" id="challengebtn" title="Challenge friend to a live 1v1"><span><svg width="17" height="17"
              viewBox="0 0 18 18">
              <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3.5 3.5L11 11" />
                <path d="M9.8 11.2l1.4-1.4" />
                <path d="M14.5 3.5L7 11" />
                <path d="M8.2 11.2l-1.4-1.4" />
              </g>
            </svg></span><br />Challenge</button>
        <button className="tool" id="historybtn" title="Daily history"><span><svg width="17" height="17"
              viewBox="0 0 18 18">
              <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3 15.5h12" />
                <path d="M5.5 15.5v-5" />
                <path d="M9 15.5v-8" />
                <path d="M12.5 15.5v-3" />
              </g>
            </svg></span><br />History</button>
        <button className="tool" id="morebtn"><svg width="6" height="16" viewBox="0 0 6 16">
            <g fill="#111">
              <circle cx="3" cy="3" r="1.6" />
              <circle cx="3" cy="8" r="1.6" />
              <circle cx="3" cy="13" r="1.6" />
            </g>
          </svg><br />More</button>
      </div>
    </header>
    <hr className="dash" />
    <div id="banner">
      <div id="banner-wrap">
        <span id="banner-text">THIS IS A PRACTICE TEST</span>
        <span id="scorepill" style={{ display: "none" }}></span>
      </div>
      <button id="challexit" title="Exit Challenge">Exit ✕</button>
    </div>
    <div id="panes">
      <div id="left">
        <div id="passage"></div>
      </div>
      <div id="divider">
        <div id="handle"><svg width="14" height="10" viewBox="0 0 14 10">
            <g stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 5h11" />
              <path d="M4 2.5L1.5 5 4 7.5" />
              <path d="M10 2.5l2.5 2.5L10 7.5" />
            </g>
          </svg></div>
      </div>
      <div id="right">
        <div id="qhead">
          <div id="qbadge">1</div>
          <button id="markbtn" title="Mark for review">
            <svg width="15" height="18" viewBox="0 0 15 18">
              <path d="M2 1h11v15l-5.5-4-5.5 4z" fill="none" stroke="#111" strokeWidth="1.8" />
            </svg>
            <span>Mark for Review</span>
          </button>
        </div>
        <hr id="qrule" />
        <div id="stem"></div>
        <div id="opts"></div>
        <div id="waitfriend"><span className="tdots"><i></i><i></i><i></i></span><span>Waiting for friend…</span></div>
        <div id="expbar"></div>
        <div id="exptext"></div>
      </div>
    </div>
    <hr className="dash" />
    <footer id="footer">
      <form id="namebox" title="Account" onSubmit={(e) => e.preventDefault()}>
        <button id="authbtn" type="button" className="footer-auth-btn">Sign In</button>
        <span id="whoami" className="footer-user-pill" style={{ display: "none" }}></span>
      </form>
      <span id="challpill" style={{ display: "none" }}></span>
      <button id="navpill">Question 1 <svg width="11" height="7" viewBox="0 0 11 7" style={{ verticalAlign: "1px" }}>
          <path d="M1 5.8L5.5 1.5 10 5.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
            strokeLinejoin="round" />
        </svg></button>
      <div id="navbtns">
        <button className="btn-ghost" id="backbtn">Back</button>
        <button className="btn-blue" id="nextbtn">Next</button>
        <button className="btn-end-test" id="rush-endbtn" style={{ display: "none" }}>End Test 🏁</button>
      </div>
    </footer>
  </div>

  <div className="overlay" id="ov-search">
    <div className="modal" style={{ maxWidth: "720px" }}>
      <h2>Search all questions</h2>
      <input type="text" id="searchinput" placeholder="Type a word, phrase, or question ID…" autoComplete="off" />
      <div id="searchmeta"></div>
      <div id="searchresults"></div>
      <div className="mrow"><button className="btn-ghost" id="searchclose">Close</button></div>
    </div>
  </div>

  <div className="overlay" id="ov-nav">
    <div className="modal" style={{ maxWidth: "720px" }}>
      <div className="navcount" id="navcount"></div>
      <div className="navstats" id="navstats"></div>
      <div id="navgrid"></div>
      <div className="mrow"><button id="navclose">Close</button><button id="nav-end-rush" style={{ display: "none" }} className="btn-end-test">End Test 🏁</button></div>
    </div>
  </div>

  <div className="overlay" id="ov-filter">
    <div className="modal">
      <h2>Filters</h2>
      <p style={{ color: "var(--muted)", fontSize: "13px" }}>Saved automatically. Empty = show all.</p>
      <div className="fsec">Category</div>
      <div id="f-dom"></div>
      <div className="fsec">Difficulty</div>
      <div id="f-dif"></div>
      <div className="mrow"><button className="btn-ghost" id="f-clear">Show all</button><button className="btn-blue"
          id="f-close">Done</button></div>
    </div>
  </div>

  <div className="overlay" id="ov-history">
    <div className="modal hist-modal" style={{ maxWidth: "520px" }}>
      <h2 className="hist-title">History</h2>
      <div className="hist-rule"></div>
      <div id="hist-body">
        <div className="skel" style={{ height: "120px" }}></div>
      </div>
    </div>
  </div>

  <div className="overlay" id="ov-challenge">
    <div className="modal" style={{ maxWidth: "560px" }}>
      <h2 className="chall-title">Challenge friends</h2>
      <div className="chall-rule"></div>
      <input type="hidden" id="chall-guest" value="" />
      <div id="opp-list"></div>
      <div className="fsec">Mode</div>
      <div className="chall-pick" id="chall-mode-pick">
        <button type="button" data-mode="wait" className="sel">WAIT</button>
        <button type="button" data-mode="rush">RUSH</button>
      </div>
      <div className="fsec">Category</div>
      <div className="chall-pick" id="chall-pool-pick">
        <button type="button" data-pool="all" className="sel">All</button>
        <button type="button" data-pool="custom">Filter</button>
      </div>
      <div id="chall-filter-wrap" style={{ display: "none", marginTop: "8px", gap: "8px" }}>
        <select id="chall-filter-dom" className="chall-select">
          <option value="">All Categories</option>
          <option value="Standard English Conventions">Grammar</option>
          <option value="Information and Ideas">Information and Ideas</option>
          <option value="Craft and Structure">Craft and Structure</option>
          <option value="Expression of Ideas">Expression of Ideas</option>
        </select>
        <select id="chall-filter-dif" className="chall-select">
          <option value="">All Difficulties</option>
          <option value="Hard">Hard</option>
          <option value="Medium">Medium</option>
          <option value="Easy">Easy</option>
        </select>
      </div>
      <div className="fsec">Questions</div>
      <div className="chall-pick" id="chall-pick">
        <button data-n="5">5</button>
        <button data-n="10" className="sel">10</button>
        <button data-n="20">20</button>
      </div>
      <div id="chall-msg" className="duo-msg" style={{ display: "none" }}></div>
      <div className="mrow"><button id="challclose">Cancel</button><button id="challsend">Send challenge →</button></div>
    </div>
  </div>

  <div className="overlay" id="ov-rush-waiting">
    <div className="brutal-modal" onClick={(e) => e.stopPropagation()}>
      {/* Perfect Circle Lock Icon */}
      <div className="icon-circle">
        <svg viewBox="0 0 24 24">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>

      <h2>Test Submitted</h2>
      
      {/* Rounded Pill Waiting Area */}
      <div className="waiting-pill">
        <span className="waiting-text" id="rush-wait-status">Waiting for others</span>
        <div className="loader-dots">
          <div className="dot"></div>
          <div className="dot"></div>
          <div className="dot"></div>
        </div>
      </div>
    </div>
  </div>

  <div className="overlay" id="ov-challend">
    <div className="modal challend-modal" onClick={(e) => e.stopPropagation()}>
      <div id="end-trophy" style={{ display: "none" }}></div>
      <h2 className="challend-headline" id="end-title">You win!</h2>
      <div id="end-sub" style={{ display: "none" }}></div>
      <div id="end-grid"></div>
      <div id="end-times"></div>
      <button className="challend-btn-keep" id="endclose">Keep Practicing</button>
    </div>
  </div>

  <div className="overlay" id="ov-profile">
    <div className="profile-modal" id="prof-card" onClick={(e) => e.stopPropagation()}>
      <div className="prof-header-top">
        <h2 className="prof-player-name" id="prof-name">—</h2>
        <div className="prof-streak-badge" id="prof-streak">
          <span>🔥</span> <span id="prof-streak-text">0 Win Streak</span>
        </div>
      </div>

      <div className="prof-section-head">Duel Statistics</div>
      
      <div className="prof-stats-grid">
        <div className="prof-stat-box">
          <div className="prof-stat-label">Win Rate</div>
          <div className="prof-stat-num" id="prof-winrate">0%</div>
          <div className="prof-stat-sub" id="prof-sub-winrate">0 W · 0 L</div>
        </div>

        <div className="prof-stat-box">
          <div className="prof-stat-label">Duels Won</div>
          <div className="prof-stat-num" id="prof-won">0</div>
          <div className="prof-stat-sub" id="prof-sub-won">0 played</div>
        </div>

        <div className="prof-stat-box">
          <div className="prof-stat-label">Average Speed</div>
          <div className="prof-stat-num" id="prof-speed">—</div>
          <div className="prof-stat-sub">per question</div>
        </div>

        <div className="prof-stat-box">
          <div className="prof-stat-label">Best Streak</div>
          <div className="prof-stat-num" id="prof-best-streak">0</div>
          <div className="prof-stat-sub">consecutive</div>
        </div>
      </div>

      <div className="prof-accuracy-box">
        <div className="prof-acc-header">
          <div className="prof-acc-label">Overall Accuracy</div>
          <div className="prof-acc-num" id="prof-acc">0%</div>
        </div>
        <div className="prof-acc-track">
          <div className="prof-acc-fill" id="prof-bar-acc" style={{ width: "0%" }}></div>
        </div>
      </div>

      <div className="prof-solved-box">
        <div className="prof-solved-label">Questions Solved</div>
        <div className="prof-solved-num" id="prof-solved">0</div>
      </div>

      <div id="prof-self-actions" style={{ display: "none", marginTop: "14px", textAlign: "center" }}>
        <button id="prof-switch-btn" type="button" className="auth-link-btn">
          Switch Account / Change PIN
        </button>
      </div>
    </div>
  </div>

  <div className="overlay" id="ov-auth">
    <div className="modal auth-modal" onClick={(e) => e.stopPropagation()}>
      <h2 className="chall-title" id="auth-title">Sign In</h2>
      <div className="chall-rule"></div>

      <div id="auth-view-login">
        <div className="auth-field">
          <label className="auth-label" htmlFor="nameinput">Name</label>
          <input
            id="nameinput"
            type="text"
            maxLength="20"
            placeholder="Enter your display name"
            autoComplete="off"
          />
        </div>

        <div className="auth-field">
          <div className="auth-label-row">
            <label className="auth-label" htmlFor="pininput">PIN</label>
            <span className="auth-hint">4+ chars · new names set a PIN</span>
          </div>
          <input
            id="pininput"
            type="password"
            maxLength="64"
            placeholder="Enter your PIN"
            autoComplete="current-password"
          />
        </div>

        <div id="auth-msg" className="auth-msg" style={{ display: "none" }}></div>

        <button id="namesave" type="button" className="auth-submit-btn">
          Continue
        </button>

        <div className="auth-footer-row">
          <button id="auth-to-pin" type="button" className="auth-link-btn" style={{ display: "none" }}>
            Change PIN
          </button>
          <button id="authclose" type="button" className="auth-cancel-btn">
            Cancel
          </button>
        </div>
      </div>

      <div id="auth-view-pin" style={{ display: "none" }}>
        <div className="auth-field">
          <label className="auth-label" htmlFor="auth-old-pin">Current PIN</label>
          <input
            id="auth-old-pin"
            type="password"
            maxLength="64"
            placeholder="Enter current PIN"
            autoComplete="current-password"
          />
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="auth-new-pin">New PIN</label>
          <input
            id="auth-new-pin"
            type="password"
            maxLength="64"
            placeholder="At least 4 characters"
            autoComplete="new-password"
          />
        </div>

        <div id="auth-pin-msg" className="auth-msg" style={{ display: "none" }}></div>

        <button id="auth-pin-save" type="button" className="auth-submit-btn">
          Update PIN
        </button>

        <div className="auth-footer-row">
          <button id="auth-back-login" type="button" className="auth-link-btn">
            Back
          </button>
          <button id="auth-pin-close" type="button" className="auth-cancel-btn">
            Cancel
          </button>
        </div>
      </div>
    </div>
  </div>

  <div id="invitebanner">
    <div className="pill-icon-wrap" aria-hidden="true">
      <svg className="pill-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/>
        <line x1="13" y1="19" x2="19" y2="13"/>
        <line x1="16" y1="16" x2="20" y2="20"/>
        <line x1="19" y1="21" x2="21" y2="19"/>
        <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/>
        <line x1="5" y1="14" x2="9" y2="18"/>
        <line x1="7" y1="17" x2="4" y2="20"/>
        <line x1="3" y1="19" x2="5" y2="21"/>
      </svg>
    </div>
    <div className="pill-text">
      <span className="pill-host" id="invite-from">Friend</span>
      <span className="pill-trio" id="invite-others" style={{ display: "none" }}></span>
      <span>challenged you to</span>
      <span className="pill-mode mode-wait" id="invite-mode">WAIT</span>
      <span className="pill-qs"><span id="invite-n">10</span> Qs</span>
    </div>
    <div className="pill-actions">
      <button className="btn-pill-accept" id="invite-accept">
        <span>Accept</span>
        <span style={{ fontSize: "11px" }}>↵</span>
      </button>
      <button className="btn-pill-decline" id="invite-decline">Decline</button>
    </div>
  </div>
  <div id="countdown">
    <div id="countnum">3</div>
  </div>
  <div id="toasts"></div>

  <div id="moreMenu">
    <button id="mm-search">Search questions…</button>
    <button id="mm-filter">Filters… <span id="mm-fcount"></span></button>
    <button id="mm-shuffle">Shuffle</button>
    <button id="mm-first">Go to first question</button>
    <button id="mm-clear">Clear answer for this question</button>
    <button id="mm-reset">Reset all progress</button>
  </div>

  <div id="hlpop" role="toolbar" aria-label="Highlight">
    <button data-hlc="y" title="Highlight yellow"><span className="dot dot-y"></span></button>
    <button data-hlc="b" title="Highlight blue"><span className="dot dot-b"></span></button>
    <button data-hlc="p" title="Highlight pink"><span className="dot dot-p"></span></button>
    <span className="sep"></span>
    <button id="hl-del" title="Remove highlight">🗑</button>
  </div>

    </>
  );
}
