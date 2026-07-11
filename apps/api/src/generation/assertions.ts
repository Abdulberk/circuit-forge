/**
 * Assertion evaluation now lives in eda-core (so the Monte-Carlo WORKER, which depends only on eda-core, can
 * evaluate each variant's acceptance criteria locally). This module re-exports it unchanged so every existing
 * API import path keeps working. The API's AssertionDto (the HTTP-validation class in ./dto) is structurally
 * an AcceptanceCriterion, so callers passing AssertionDto[] to evaluateAssertions are accepted as before.
 */
export {
    nodeKey,
    isCurrentProbe,
    currentKey,
    isObservableCurrentProbe,
    extraProbesForCriteria,
    compareAssertion,
    evaluateAssertions,
    attachFourierThd,
    attachTransferFunction,
    describeFailure,
    criterionDimension,
    requiredDimensions,
    uncoveredRequiredDimensions,
    type AcceptanceCriterion,
    type AssertionResult,
    type SpecDimension,
} from '@circuit-forge/eda-core';
