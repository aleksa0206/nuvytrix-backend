import { ErrorCode } from './errorCodes';

export const ErrorMessages: Record<ErrorCode, string> = {
  [ErrorCode.VALIDATION_ERROR]: 'Validation failed',
  [ErrorCode.MALFORMED_JSON]: 'Malformed JSON body',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'Request body too large',
  [ErrorCode.UNAUTHORIZED]: 'Authentication required',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid username or password',
  [ErrorCode.ACCOUNT_LOCKED]: 'Account temporarily locked after too many failed login attempts',
  [ErrorCode.TOO_MANY_REQUESTS]: 'Too many requests, please try again later',
  [ErrorCode.NOT_FOUND]: 'Resource not found',
  [ErrorCode.ROUTE_NOT_FOUND]: 'Route not found',
  [ErrorCode.CONFLICT]: 'Resource already exists',
  [ErrorCode.INTERNAL_ERROR]: 'Internal server error',

  [ErrorCode.SCAN_TARGET_NOT_ALLOWED]: 'Scan target is outside the allowed local networks',
  [ErrorCode.SCAN_ALREADY_RUNNING]: 'A discovery scan is already running',
  [ErrorCode.DEVICE_NOT_FOUND]: 'Device not found',
  [ErrorCode.SCAN_NOT_FOUND]: 'Scan not found',

  [ErrorCode.FIREWALL_FILE_REQUIRED]: 'A firewall log file is required',
  [ErrorCode.FIREWALL_FILE_INVALID]: 'Only plain-text log files are accepted',
  [ErrorCode.FIREWALL_EVENT_NOT_FOUND]: 'Firewall event not found',
  [ErrorCode.FIREWALL_IMPORT_NOT_FOUND]: 'Firewall log import not found',
  [ErrorCode.FIREWALL_POLICY_NOT_FOUND]: 'Firewall policy not found',
  [ErrorCode.FIREWALL_POLICY_INVALID_TRANSITION]: 'This status change is not allowed',
  [ErrorCode.CONFIRMATION_REQUIRED]: 'This action requires explicit confirmation',

  [ErrorCode.MONITORING_TARGET_NOT_FOUND]: 'Monitoring target not found',
  [ErrorCode.MONITORING_TARGET_MANAGED]:
    'This target is managed by configuration and cannot be changed here',

  [ErrorCode.DNS_NOT_CONFIGURED]: 'No DNS provider is configured',
  [ErrorCode.DNS_PROVIDER_UNAVAILABLE]: 'The DNS provider could not be reached',

  [ErrorCode.ROUTER_NOT_CONFIGURED]: 'Router access is not configured',
  [ErrorCode.ROUTER_NO_DATA]: 'The router has not been read yet',
  [ErrorCode.ROUTER_POLL_RUNNING]: 'The router is being read right now',
  [ErrorCode.ROUTER_UNAVAILABLE]: 'The router could not be reached',
  [ErrorCode.ROUTER_WRITES_DISABLED]:
    'Changing router settings is turned off (ROUTER_WRITES_ENABLED on the server)',
  [ErrorCode.ROUTER_WRITE_REFUSED]: 'This change is not allowed',
  [ErrorCode.ROUTER_WRITE_NOT_APPLIED]:
    'The router did not show the change after saving. Check the rules on the router.',
  [ErrorCode.ROUTER_RULE_NOT_FOUND]: 'This entry no longer exists on the router',
};
