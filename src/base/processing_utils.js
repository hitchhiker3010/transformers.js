
/**
 * @file Processors are used to prepare non-textual inputs (e.g., image or audio) for a model.
 * 
 * **Example:** Using a `WhisperProcessor` to prepare an audio input for a model.
 * ```javascript
 * import { AutoProcessor, read_audio } from '@huggingface/transformers';
 *
 * let processor = await AutoProcessor.from_pretrained('openai/whisper-tiny.en');
 * let audio = await read_audio('https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/mlk.flac', 16000);
 * let { input_features } = await processor(audio);
 * // Tensor {
 * //   data: Float32Array(240000) [0.4752984642982483, 0.5597258806228638, 0.56434166431427, ...],
 * //   dims: [1, 80, 3000],
 * //   type: 'float32',
 * //   size: 240000,
 * // }
 * ```
 * 
 * @module processors
 */
import {
    Callable,
} from '../utils/generic.js';

/**
 * @typedef {Object} ProcessorProperties Additional processor-specific properties.
 * @typedef {import('../utils/hub.js').PretrainedOptions & ProcessorProperties} PretrainedProcessorOptions
 */


/**
 * Represents a Processor that extracts features from an input.
 */
export class Processor extends Callable {
    static classes = [
        'image_processor_class',
        'tokenizer_class',
        'feature_extractor_class',
    ]

    /**
     * Creates a new Processor with the given components
     * @param {Object} config 
     * @param {Record<string, Object>} components 
     */
    constructor(config, components) {
        super();
        this.config = config;
        this.components = components;
    }

    /**
     * @returns {import('./image_processors_utils.js').ImageProcessor|undefined} The image processor of the processor, if it exists.
     */
    get image_processor() {
        return this.components.image_processor;
    }

    /**
     * @returns {import('../tokenizers.js').PreTrainedTokenizer|undefined} The tokenizer of the processor, if it exists.
     */
    get tokenizer() {
        return this.components.tokenizer;
    }

    /**
     * @returns {import('./feature_extraction_utils.js').FeatureExtractor|undefined} The feature extractor of the processor, if it exists.
     */
    get feature_extractor() {
        return this.components.feature_extractor;
    }
    
    /**
     * Calls the feature_extractor function with the given input.
     * @param {any} input The input to extract features from.
     * @param {...any} args Additional arguments.
     * @returns {Promise<any>} A Promise that resolves with the extracted features.
     */
    async _call(input, ...args) {
        for (const item of [this.image_processor, this.feature_extractor, this.tokenizer]) {
            if (item) {
                return item(input, ...args);
            }
        }
        throw new Error('No image processor, feature extractor, or tokenizer found.');
    }


    /**
     * Instantiate one of the processor classes of the library from a pretrained model.
     * 
     * The processor class to instantiate is selected based on the `feature_extractor_type` property of the config object
     * (either passed as an argument or loaded from `pretrained_model_name_or_path` if possible)
     * 
     * @param {string} pretrained_model_name_or_path The name or path of the pretrained model. Can be either:
     * - A string, the *model id* of a pretrained processor hosted inside a model repo on huggingface.co.
     *   Valid model ids can be located at the root-level, like `bert-base-uncased`, or namespaced under a
     *   user or organization name, like `dbmdz/bert-base-german-cased`.
     * - A path to a *directory* containing processor files, e.g., `./my_model_directory/`.
     * @param {PretrainedProcessorOptions} options Additional options for loading the processor.
     * 
     * @returns {Promise<Processor>} A new instance of the Processor class.
     */
    static async from_pretrained(pretrained_model_name_or_path, options) {

        // console.log('FROM PRETRAINED');
        // console.log(this.classes);
        // console.log(this.classes.map((cls) => cls in this));

        const [config, components] = await Promise.all([
            // TODO:
            // getModelJSON(pretrained_model_name_or_path, PROCESSOR_NAME, true, options),
            {},
            Promise.all(
                this.classes
                .filter((cls) => cls in this)
                .map(async (cls) => {
                    const component = await this[cls].from_pretrained(pretrained_model_name_or_path, options);
                    return [cls.replace(/_class$/,''), component];
                })
            ).then(Object.fromEntries)
        ]);

        return new this(config, components);
    }
}