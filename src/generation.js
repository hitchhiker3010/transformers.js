const { Tensor } = require("./tensor_utils.js");
const {
    Callable,
    exists,
    log_softmax
} = require("./utils.js");

/**
 * A class representing a list of logits processors. A logits processor is a function that modifies the logits
 * output of a language model. This class provides methods for adding new processors and applying all processors to a
 * batch of logits.
 *
 * @extends Callable
 */
class LogitsProcessorList extends Callable {

    constructor() {
        super();
        this.processors = [];
    }

    /**
     * Adds a new logits processor to the list.
     *
     * @param {function} item - The logits processor function to add.
     */
    push(item) {
        this.processors.push(item);
    }

    /**
     * Adds multiple logits processors to the list.
     *
     * @param {Array<function>} items - The logits processor functions to add.
     */
    extend(items) {
        this.processors.push(...items);
    }

    /**
     * Applies all logits processors in the list to a batch of logits, modifying them in-place.
     *
     * @param {Array<number>} input_ids - The input IDs for the language model.
     * @param {Array<Array<number>>} batchedLogits - A 2D array of logits, where each row corresponds to a single
     *                                                input sequence in the batch.
     */
    _call(input_ids, batchedLogits) {
        // NOTE: This is different from the Python code, since vanilla JS does not support vectorized operations. 
        // As a result, we apply each processor to each item in the batch.
        for (let logits of batchedLogits) {
            // Modifies logits inplace
            this.processors.forEach(
                func => func(input_ids, logits)
            )
        }
    }

    [Symbol.iterator]() {
        return this.processors.values();
    }
}

/**
 * Base class for processing logits.
 * @extends Callable
 */
class LogitsProcessor extends Callable {
    /**
     * Apply the processor to the input logits.
     *
     * @abstract
     * @param {Array} input_ids The input ids.
     * @param {Tensor} logits The logits to process.
     * @throws {Error} Throws an error if `_call` is not implemented in the subclass.
     */
    _call(input_ids, logits) {
        throw Error("`_call` should be implemented in a subclass")
    }
}

/**
 * A logits processor that forces a specific token to be generated by the decoder.
 * 
 * @extends LogitsProcessor
 */
class ForceTokensLogitsProcessor extends LogitsProcessor {
    /**
     * Constructs a new instance of `ForceTokensLogitsProcessor`.
     * 
     * @param {Array} forced_decoder_ids The ids of tokens that should be forced.
     */
    constructor(forced_decoder_ids) {
        super();
        this.force_token_map = Object.fromEntries(forced_decoder_ids ?? []);
    }

    /**
     * Apply the processor to the input logits.
     *
     * @param {Array} input_ids The input ids.
     * @param {any} logits The logits to process.
     * @returns {Array} The processed logits.
     */
    _call(input_ids, logits) {
        let map = this.force_token_map[input_ids.length];
        if (exists(map)) { // There exists a mapping
            logits.data.fill(-Infinity)
            logits.data[map] = 0;
        }
        return logits;
    }
}

/**
 * A LogitsProcessor that forces a BOS token at the beginning of the generated sequence.
 * @extends LogitsProcessor
 */
class ForcedBOSTokenLogitsProcessor extends LogitsProcessor {
    /**
     * Create a ForcedBOSTokenLogitsProcessor.
     * @param {number} bos_token_id - The ID of the beginning-of-sequence token to be forced.
     */
    constructor(bos_token_id) {
        super();
        this.bos_token_id = bos_token_id;
    }

    /**
     * Apply the BOS token forcing to the logits.
     * @param {Array} input_ids - The input IDs.
     * @param {Object} logits - The logits.
     * @returns {Object} The logits with BOS token forcing.
     */
    _call(input_ids, logits) {
        if (input_ids.length === 1) {
            logits.data.fill(-Infinity)
            logits.data[this.bos_token_id] = 0;
        }
    }
}

/**
 * A logits processor that forces end-of-sequence token probability to 1.
 * 
 * @extends LogitsProcessor
 */
class ForcedEOSTokenLogitsProcessor extends LogitsProcessor {
    /**
     * Create a ForcedEOSTokenLogitsProcessor.
     * @param {number} max_length - Max length of the sequence.
     * @param {number} forced_eos_token_id - The ID of the end-of-sequence token to be forced.
     */
    constructor(max_length, forced_eos_token_id) {
        super();
        this.max_length = max_length;
        this.forced_eos_token_id = forced_eos_token_id;
    }

    /**
     * Apply the processor to input_ids and logits.
     * 
     * @param {number[]} input_ids - The input ids.
     * @param {any} logits - The logits tensor.
     */
    _call(input_ids, logits) {
        // TODO - 
        throw Error("Not yet implemented");
    }
}

/**
 * A LogitsProcessor that handles adding timestamps to generated text.
 * @extends LogitsProcessor
 */
class WhisperTimeStampLogitsProcessor extends LogitsProcessor {
    /**
     * Constructs a new WhisperTimeStampLogitsProcessor.
     * @param {object} generate_config - The config object passed to the `generate()` method of a transformer model.
     * @param {number} generate_config.eos_token_id - The ID of the end-of-sequence token.
     * @param {number} generate_config.no_timestamps_token_id - The ID of the token used to indicate that a token should not have a timestamp.
     * @param {Array<Array<number>>} [generate_config.forced_decoder_ids] - An array of two-element arrays representing decoder IDs that are forced to appear in the output. The second element of each array indicates whether the token is a timestamp.
     * @param {number} [generate_config.max_initial_timestamp_index] - The maximum index at which an initial timestamp can appear.
     */
    constructor(generate_config) {
        super();
        this.eos_token_id = generate_config.eos_token_id;
        this.no_timestamps_token_id = generate_config.no_timestamps_token_id;
        this.timestamp_begin = this.no_timestamps_token_id + 1;

        this.begin_index = (generate_config.forced_decoder_ids || []).length + 2;
        if (generate_config.forced_decoder_ids.slice(-1)[0][1] === this.no_timestamps_token_id) {
            this.begin_index -= 1;
        }
        this.max_initial_timestamp_index = generate_config.max_initial_timestamp_index;

    }

    /**
     * Modify the logits to handle timestamp tokens.
     * @param {Array} input_ids - The input sequence of tokens.
     * @param {Tensor} logits - The logits output by the model.
     * @returns {Tensor} - The modified logits.
     */
    _call(input_ids, logits) {
        // suppress <|notimestamps|> which is handled by without_timestamps
        logits.data[this.no_timestamps_token_id] = -Infinity;

        if (input_ids.length === this.begin_index - 1) {
            logits.data.fill(-Infinity);
            logits.data[this.timestamp_begin] = 0;
            return logits;
        }

        // timestamps have to appear in pairs, except directly before eos_token; mask logits accordingly
        const seq = input_ids.slice(this.begin_index);
        const last_was_timestamp = seq.length >= 1 && seq[seq.length - 1] >= this.timestamp_begin;
        const penultimate_was_timestamp = seq.length < 2 || seq[seq.length - 2] >= this.timestamp_begin;

        if (last_was_timestamp) {
            if (penultimate_was_timestamp) { // has to be non-timestamp
                logits.data.subarray(this.timestamp_begin).fill(-Infinity);
            } else { // cannot be normal text tokens
                logits.data.subarray(0, this.eos_token_id).fill(-Infinity);
            }
        }

        // apply the `max_initial_timestamp` option
        if (input_ids.length === this.begin_index && this.max_initial_timestamp_index !== null) {
            const last_allowed = this.timestamp_begin + this.max_initial_timestamp_index;
            logits.data.subarray(last_allowed + 1).fill(-Infinity);
        }

        // if sum of probability over timestamps is above any other token, sample timestamp
        const logprobs = log_softmax(logits.data);
        const timestamp_logprob = Math.log(logprobs.subarray(this.timestamp_begin).map(Math.exp).reduce((a, b) => a + b));
        const max_text_token_logprob = Math.max(...logprobs.subarray(0, this.timestamp_begin));
        if (timestamp_logprob > max_text_token_logprob) {
            logits.data.subarray(0, this.timestamp_begin).fill(-Infinity);
        }

        return logits;
    }
}

const getNgrams = (ngramSize, prevInputIds) => {
    const curLen = prevInputIds.length;
    const ngrams = [];
    for (let j = 0; j < curLen + 1 - ngramSize; ++j) {
        const ngram = [];
        for (let k = 0; k < ngramSize; ++k) {
            ngram.push(prevInputIds[j + k]);
        }
        ngrams.push(ngram);
    }
    const generatedNgram = new Map();
    for (const ngram of ngrams) {
        const prevNgram = ngram.slice(0, ngram.length - 1);
        const prevNgramKey = JSON.stringify(prevNgram);
        const prevNgramValue = generatedNgram.get(prevNgramKey) ?? [];
        prevNgramValue.push(ngram[ngram.length - 1]);
        generatedNgram.set(prevNgramKey, prevNgramValue);
    }
    return generatedNgram;
};

const getGeneratedNgrams = (bannedNgrams, prevInputIds, ngramSize) => {
    const ngramIdx = prevInputIds.slice(prevInputIds.length + 1 - ngramSize, prevInputIds.length);
    const banned = bannedNgrams.get(JSON.stringify(ngramIdx)) ?? [];
    return banned;
};

const calcBannedNgramTokens = (ngramSize, prevInputIds) => {
    const bannedTokens = [];
    if (prevInputIds.length + 1 < ngramSize) {
        // return no banned tokens if we haven't generated no_repeat_ngram_size tokens yet
        return bannedTokens;

    } else {
        const generatedNgrams = getNgrams(ngramSize, prevInputIds);

        const bannedTokens = getGeneratedNgrams(
            generatedNgrams,
            prevInputIds,
            ngramSize,
        );
        return bannedTokens;
    }
};

class NoRepeatNGramLogitsProcessor extends LogitsProcessor {
    constructor(no_repeat_ngram_size) {
        super();
        this.no_repeat_ngram_size = no_repeat_ngram_size;
    }

    _call(input_ids, logits) {
        const bannedTokens = calcBannedNgramTokens(
            this.no_repeat_ngram_size,
            input_ids,
        );

        for (const token of bannedTokens) {
            logits.data[token] = -Infinity;
        }
        return logits;
    }
}


class RepetitionPenaltyLogitsProcessor extends LogitsProcessor {
    constructor(penalty) {
        super();
        this.penalty = penalty;
    }

    _call(input_ids, logits) {
        // Modify the logits corresponding to each element in `input_ids`.
        // As a consequence, the logits corresponding to tokens that appear
        // many times in the output will be penalised more.
        for (const input_id of input_ids) {
            if (logits.data[input_id] < 0) {
                logits.data[input_id] *= this.penalty;
            } else {
                logits.data[input_id] /= this.penalty;
            }
        }
        return logits
    }
}


class GenerationConfig {
    constructor(kwargs = {}) {
        // Parameters that control the length of the output
        // TODO: extend the configuration with correct types
        /**
         * Create a GenerationConfig object
         * @constructor
         * @param {Object} [kwargs={}] - The configuration parameters
         * @param {number} [kwargs.max_length=20] - The maximum length of the generated text
         * @param {number} [kwargs.max_new_tokens=null] - The maximum number of new tokens to generate
         * @param {number} [kwargs.min_length=0] - The minimum length of the generated text
         * @param {number} [kwargs.min_new_tokens=null] - The minimum number of new tokens to generate
         * @param {boolean} [kwargs.early_stopping=false] - Whether to stop generation early if a stop token is encountered
         * @param {number} [kwargs.max_time=null] - The maximum amount of time to spend generating text
         * @param {boolean} [kwargs.do_sample=false] - Whether to use sampling when generating text
         * @param {number} [kwargs.num_beams=1] - The number of beams to use when generating text
         * @param {number} [kwargs.num_beam_groups=1] - The number of beam groups to use when generating text
         * @param {number} [kwargs.penalty_alpha=null] - The value of the alpha penalty to use when generating text
         * @param {boolean} [kwargs.use_cache=true] - Whether to use cache when generating text
         * @param {number} [kwargs.temperature=1.0] - The temperature to use when generating text
         * @param {number} [kwargs.top_k=50] - The value of k to use when generating text
         * @param {number} [kwargs.top_p=1.0] - The value of p to use when generating text
         * @param {number} [kwargs.typical_p=1.0] - The typical value of p to use when generating text
         * @param {number} [kwargs.epsilon_cutoff=0.0] - The value of epsilon cutoff to use when generating text
         * @param {number} [kwargs.eta_cutoff=0.0] - The value of eta cutoff to use when generating text
         * @param {number} [kwargs.diversity_penalty=0.0] - The value of diversity penalty to use when generating text
         * @param {number} [kwargs.repetition_penalty=1.0] - The value of repetition penalty to use when generating text
         * @param {number} [kwargs.encoder_repetition_penalty=1.0] - The value of encoder repetition penalty to use when generating text
         * @param {number} [kwargs.length_penalty=1.0] - The value of length
         * @param {number} [kwargs.no_repeat_ngram_size=0] - The size of the n-grams to avoid repeating in the generated output.
         * @param {?Array<number>} [kwargs.bad_words_ids=null] - An array of IDs representing tokens that should not be generated.
         * @param {?Array<number>} [kwargs.force_words_ids=null] - An array of IDs representing tokens that must be generated.
         * @param {boolean} [kwargs.renormalize_logits=false] - Whether or not to renormalize the logits before generating new tokens.
         * @param {?Array<Object>} [kwargs.constraints=null] - An array of constraint objects to apply during generation.
         */
        this.max_length = kwargs.max_length ?? 20;
        this.max_new_tokens = kwargs.max_new_tokens ?? null;
        this.min_length = kwargs.min_length ?? 0;
        this.min_new_tokens = kwargs.min_new_tokens ?? null;
        this.early_stopping = kwargs.early_stopping ?? false;
        this.max_time = kwargs.max_time ?? null;

        // Parameters that control the generation strategy used
        this.do_sample = kwargs.do_sample ?? false;
        this.num_beams = kwargs.num_beams ?? 1;
        this.num_beam_groups = kwargs.num_beam_groups ?? 1;
        this.penalty_alpha = kwargs.penalty_alpha ?? null;
        this.use_cache = kwargs.use_cache ?? true;

        // Parameters for manipulation of the model output logits
        this.temperature = kwargs.temperature ?? 1.0;
        this.top_k = kwargs.top_k ?? 50;
        this.top_p = kwargs.top_p ?? 1.0;
        this.typical_p = kwargs.typical_p ?? 1.0;
        this.epsilon_cutoff = kwargs.epsilon_cutoff ?? 0.0;
        this.eta_cutoff = kwargs.eta_cutoff ?? 0.0;
        this.diversity_penalty = kwargs.diversity_penalty ?? 0.0;
        this.repetition_penalty = kwargs.repetition_penalty ?? 1.0;
        this.encoder_repetition_penalty = kwargs.encoder_repetition_penalty ?? 1.0;
        this.length_penalty = kwargs.length_penalty ?? 1.0;
        this.no_repeat_ngram_size = kwargs.no_repeat_ngram_size ?? 0;
        this.bad_words_ids = kwargs.bad_words_ids ?? null;
        this.force_words_ids = kwargs.force_words_ids ?? null;
        this.renormalize_logits = kwargs.renormalize_logits ?? false;
        this.constraints = kwargs.constraints ?? null;
        this.forced_bos_token_id = kwargs.forced_bos_token_id ?? null;
        this.forced_eos_token_id = kwargs.forced_eos_token_id ?? null;
        this.remove_invalid_values = kwargs.remove_invalid_values ?? false;
        this.exponential_decay_length_penalty = kwargs.exponential_decay_length_penalty ?? null;
        this.suppress_tokens = kwargs.suppress_tokens ?? null;
        this.begin_suppress_tokens = kwargs.begin_suppress_tokens ?? null;
        this.forced_decoder_ids = kwargs.forced_decoder_ids ?? null;

        // Parameters that define the output variables of `generate`
        this.num_return_sequences = kwargs.num_return_sequences ?? 1;
        this.output_attentions = kwargs.output_attentions ?? false;
        this.output_hidden_states = kwargs.output_hidden_states ?? false;
        this.output_scores = kwargs.output_scores ?? false;
        this.return_dict_in_generate = kwargs.return_dict_in_generate ?? false;

        // Special tokens that can be used at generation time
        this.pad_token_id = kwargs.pad_token_id ?? null;
        this.bos_token_id = kwargs.bos_token_id ?? null;
        this.eos_token_id = kwargs.eos_token_id ?? null;

        // Generation parameters exclusive to encoder-decoder models
        this.encoder_no_repeat_ngram_size = kwargs.encoder_no_repeat_ngram_size ?? 0;
        this.decoder_start_token_id = kwargs.decoder_start_token_id ?? null;

        // Wild card
        this.generation_kwargs = kwargs.generation_kwargs ?? {};
    }
}

module.exports = {
    LogitsProcessor,
    LogitsProcessorList,
    GenerationConfig,
    ForcedBOSTokenLogitsProcessor,
    ForcedEOSTokenLogitsProcessor,
    WhisperTimeStampLogitsProcessor,
    ForceTokensLogitsProcessor,
    NoRepeatNGramLogitsProcessor,
    RepetitionPenaltyLogitsProcessor
};
