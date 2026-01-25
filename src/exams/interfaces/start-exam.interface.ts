export interface StartExamResponse {
  attempt_id: string;
  questions: {
    index: number;
    type: 'mcq' | 'essay';
    question: string;
    question_ar?: string;
    choices?: string[];
    marks: number;
  }[];
  expiration_time: Date;
  started_at: Date;
}
