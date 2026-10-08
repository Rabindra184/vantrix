import { useNavigate } from 'react-router-dom';
import Card from '../components/Card';
import PasswordChangeForm from '../components/PasswordChangeForm';
import useDocumentTitle from '../useDocumentTitle';
import { HOME_ROUTE } from './paths';

/**
 * Change your own password, reached from the account menu — the same form the
 * forced step at first sign-in uses, on an ordinary page inside the shell.
 *
 * No card title and no description: the `<h1>` names the page and the form's
 * three labels are the rest (the clean-UI text rule). A success goes home.
 */
export default function AccountPassword() {
  useDocumentTitle('Change password');
  const navigate = useNavigate();

  return (
    <div className="flex max-w-md flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Change password</h1>
      <Card>
        <PasswordChangeForm onDone={() => navigate(HOME_ROUTE)} />
      </Card>
    </div>
  );
}
