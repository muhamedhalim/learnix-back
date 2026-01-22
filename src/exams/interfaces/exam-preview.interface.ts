export interface ExamPreview {
  id: string;
  title: string;
  title_ar: string | null;
  description: string | null;
  duration_minutes: number;
  questions_count: number;
  mcq_count: number;
  essay_count: number;
  total_marks: number;
  passing_marks: number;
  teacher: {
    id: string;
    name: string;
  };
  subject: {
    id: string;
    name: string;
    grade_level: string;
  };
}
