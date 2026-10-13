import React from 'react';
import {registerRoot, Composition} from 'remotion';
import {ManxingFilm} from './video';

const Root: React.FC = () => <Composition id="ManxingDemo" component={ManxingFilm} durationInFrames={2700} fps={60} width={1920} height={1080}/>;
registerRoot(Root);
