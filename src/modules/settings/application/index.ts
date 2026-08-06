/**
 * settings 모듈 공개 인터페이스 (T0-7).
 */

export {
  SYSTEM_SETTING_ID,
  SETTING_READ_PERMISSION,
  SETTING_UPDATE_PERMISSION,
  UPDATABLE_FIELDS,
  getSystemSettings,
  updateSystemSettings,
  parseSettingPatch,
  prismaSystemSettingReader,
  type SystemSettingView,
  type SystemSettingPatch,
  type SystemSettingReader,
  type SystemSettingDependencies,
} from './system-settings';

export {
  APPROVAL_WORKFLOWS,
  ALWAYS_SEPARATED_WORKFLOWS,
  canSelfApprove,
  assertApprovalActor,
  type ApprovalWorkflow,
  type SelfApprovalSettings,
  type CanSelfApproveInput,
  type AssertApprovalActorInput,
} from '../domain/self-approval';
