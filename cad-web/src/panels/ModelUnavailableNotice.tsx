import styles from './ModelUnavailableNotice.module.css';

export type OfferedModel = { id: string; label: string };

/**
 * The model chosen in this browser isn't offered any more (retired or renamed): the ones that are, to pick from.
 * Nothing is switched without asking. Shared by STEVE's chat and Set up with STEVE.
 */
export default function ModelUnavailableNotice({ id, model, offered, onChoose }: {
  id: string; model: string; offered: OfferedModel[]; onChoose: (model: string) => void;
}) {
  return (
    <div className={styles.modelChoice} id={id} role="group" aria-label="Choose a model">
      <span><b>{model}</b> isn’t offered any more. Choose the model STEVE uses:</span>
      <div className={styles.modelOptions}>
        {offered.map((item) => (
          <button key={item.id} type="button" className={styles.modelOption} data-model={item.id} onClick={() => onChoose(item.id)}>{item.label}</button>
        ))}
      </div>
    </div>
  );
}
