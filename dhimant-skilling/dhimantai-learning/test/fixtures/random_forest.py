import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.datasets import load_iris
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split

iris = load_iris()
X = pd.DataFrame(iris.data, columns=iris.feature_names)
y = pd.Series(iris.target, name='species')
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
model = RandomForestClassifier(n_estimators=100, random_state=42, n_jobs=1)
model.fit(X_train, y_train)
predictions = model.predict(X_test)
accuracy = accuracy_score(y_test, predictions)
assert predictions.shape == (30,)
assert np.isfinite(model.feature_importances_).all()
assert accuracy >= 0.9
print(f'Random Forest accuracy: {accuracy:.3f}')
pd.Series(model.feature_importances_, index=X.columns).plot.barh()
plt.xlabel('Feature importance')
plt.tight_layout()
plt.show()
