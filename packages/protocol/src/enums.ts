// the values of enums, free of zod: a module that needs only the values loads none of the schemas
export const PANE_KINDS = ['terminal', 'browser', 'files', 'changes'] as const;
export const RETRO_SPANS = ['last', '7d', '30d'] as const;
// the two turns a device may ask to hear about
export const PUSH_STATUSES = ['blocked', 'done'] as const;
