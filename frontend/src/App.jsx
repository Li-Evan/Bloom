import { Routes, Route, Navigate } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import ProfilePage from './pages/ProfilePage'
import CoursePage from './pages/CoursePage'
import LessonPage from './pages/LessonPage'
import SyllabusPage from './pages/SyllabusPage'
import LanguageSwitcher from './components/LanguageSwitcher'

export default function App() {
  return (
    <>
      <LanguageSwitcher />
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/course/:courseId" element={<CoursePage />} />
        <Route path="/course/:courseId/syllabus" element={<SyllabusPage />} />
        <Route path="/course/:courseId/lesson/:lessonNum" element={<LessonPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </>
  )
}
