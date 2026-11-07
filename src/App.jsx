import React, { useEffect, useState } from 'react';
import SATExamView from './components/SATExamView';
import HomeworkManager from './components/homework/HomeworkManager';
import TeacherPortal from './components/teacher/TeacherPortal';
import MaintenanceScreen from './components/MaintenanceScreen';
import { MAINTENANCE_MODE } from './siteConfig';
import { initExamEngine } from './examEngine';
import './index.css';

function isTeacherRoute() {
  try {
    return (
      window.location.pathname === '/teacher' ||
      window.location.pathname.startsWith('/teacher/') ||
      window.location.hash === '#teacher' ||
      new URLSearchParams(window.location.search).get('teacher') === '1'
    );
  } catch (e) {
    return false;
  }
}

export default function App() {
  // Checked before anything loads so the exam engine and backend never start.
  if (MAINTENANCE_MODE) return <MaintenanceScreen />;
  return <MainApp />;
}

function MainApp() {
  const [showTeacher, setShowTeacher] = useState(() => isTeacherRoute());

  useEffect(() => {
    // 1. Boot the SAT exam engine
    initExamEngine();

    // 2. Load backend.js for multiplayer duels and sync
    const backendScript = document.createElement('script');
    backendScript.type = 'module';
    backendScript.src = '/backend.js';
    document.body.appendChild(backendScript);

    const onPopState = () => setShowTeacher(isTeacherRoute());
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      if (document.body.contains(backendScript)) {
        document.body.removeChild(backendScript);
      }
    };
  }, []);

  const openTeacher = () => {
    try {
      window.history.pushState({}, '', '/teacher');
    } catch (e) {}
    setShowTeacher(true);
  };

  const closeTeacher = () => {
    try {
      if (window.location.pathname.startsWith('/teacher')) {
        window.history.pushState({}, '', '/');
      }
    } catch (e) {}
    setShowTeacher(false);
  };

  return (
    <>
      <SATExamView />
      <HomeworkManager onOpenTeacher={openTeacher} />
      {showTeacher && <TeacherPortal onExit={closeTeacher} />}
    </>
  );
}
