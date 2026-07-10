/** How a guardian is related to the student. Persisted on `student_guardians`. */
export enum GuardianRelationship {
  FATHER = 'father',
  MOTHER = 'mother',
  GRANDPARENT = 'grandparent',
  SIBLING = 'sibling',
  UNCLE = 'uncle',
  AUNT = 'aunt',
  LEGAL_GUARDIAN = 'legal_guardian',
  OTHER = 'other',
}
