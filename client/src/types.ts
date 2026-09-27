export type Tool = 'pen' | 'eraser';

export type Point = {
  x: number;
  y: number;
};

export type Stroke = {
  id: string;
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
  createdAt?: number;
  undone?: boolean;
};

export type BoardState = {
  id: string;
  code: string;
  strokes: Stroke[];
  history: Stroke[];
  metadata: {
    lastActivity: number;
    createdBy: string;
  };
};

export type DeviceMeta = {
  name: string;
  isCurrent?: boolean;
};
